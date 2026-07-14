/**
 * Cost-Aware Semantic Payload Router (Section 3.4)
 *
 * Classifies outgoing LLM requests into one of three tiers — trivial,
 * moderate, or complex — and redirects each request to the cheapest
 * provider/model capable of handling it.  An escalation mechanism
 * re-issues a request to the next tier up when the initial response
 * is truncated, malformed, or duplicated.
 *
 * Configuration is loaded from ~/.agentpass/routing.json.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { routingConfigFile } from "./paths";
import { PROVIDERS, type Provider } from "./providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskTier = "trivial" | "moderate" | "complex";

export interface TierTarget {
  provider: string;
  model: string;
}

export interface EscalationConfig {
  max_hops: number;
  trigger_on: string[];
}

export interface RoutingConfig {
  enabled: boolean;
  routing_table: Record<TaskTier, TierTarget>;
  escalation: EscalationConfig;
  override_header: string;
}

export interface ClassificationResult {
  tier: TaskTier;
  features: {
    estimatedTokens: number;
    hasCodeFences: boolean;
    hasMathNotation: boolean;
    hasMultiStepInstructions: boolean;
    messageCount: number;
  };
}

export interface RoutingDecision {
  originalProvider: string;
  targetProvider: string;
  targetModel: string;
  tier: TaskTier;
  forced: boolean;
}

// ---------------------------------------------------------------------------
// Tier escalation order
// ---------------------------------------------------------------------------

const TIER_ORDER: TaskTier[] = ["trivial", "moderate", "complex"];

export function nextTier(current: TaskTier): TaskTier | null {
  const idx = TIER_ORDER.indexOf(current);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  return TIER_ORDER[idx + 1]!;
}

// ---------------------------------------------------------------------------
// Configuration I/O
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: RoutingConfig = {
  enabled: true,
  routing_table: {
    trivial: { provider: "groq", model: "llama3-8b" },
    moderate: { provider: "openai", model: "gpt-4o-mini" },
    complex: { provider: "anthropic", model: "claude-3-5-sonnet" },
  },
  escalation: {
    max_hops: 1,
    trigger_on: ["truncated_response", "low_confidence", "duplicate_retry"],
  },
  override_header: "X-AgentPass-Force-Tier",
};

export function loadRoutingConfig(): RoutingConfig | null {
  const path = routingConfigFile();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<RoutingConfig>;
    return {
      enabled: raw.enabled ?? true,
      routing_table: raw.routing_table ?? DEFAULT_CONFIG.routing_table,
      escalation: raw.escalation ?? DEFAULT_CONFIG.escalation,
      override_header: raw.override_header ?? DEFAULT_CONFIG.override_header,
    };
  } catch {
    return null;
  }
}

export function writeDefaultConfig(): string {
  const path = routingConfigFile();
  writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
  return path;
}

export function resolveProvider(name: string): Provider | null {
  return PROVIDERS.find((p) => p.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Feature Extraction
// ---------------------------------------------------------------------------

/** Approximate token count using word-count / 0.75 heuristic. */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / 0.75);
}

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const MATH_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\frac|\\sum|\\int)/;
const MULTI_STEP_RE =
  /(\b(step\s*\d|first|then|next|finally|after\s+that|secondly|thirdly)\b|(\d+\.\s+\w))/i;

export function extractFeatures(body: Record<string, unknown>): ClassificationResult["features"] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const fullText = messages
    .map((m: Record<string, unknown>) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  return {
    estimatedTokens: estimateTokens(fullText),
    hasCodeFences: CODE_FENCE_RE.test(fullText),
    hasMathNotation: MATH_RE.test(fullText),
    hasMultiStepInstructions: MULTI_STEP_RE.test(fullText),
    messageCount: messages.length,
  };
}

// ---------------------------------------------------------------------------
// Rule-Based Classifier
// ---------------------------------------------------------------------------

/**
 * Assigns a request to one of three task classes:
 *  - trivial  — short extraction or formatting instructions
 *  - moderate — summarisation, classification, short-form generation
 *  - complex  — multi-step reasoning, code generation, long-context tasks
 */
export function classify(features: ClassificationResult["features"]): TaskTier {
  // Complex indicators
  if (features.hasCodeFences) return "complex";
  if (features.hasMathNotation) return "complex";
  if (features.hasMultiStepInstructions && features.estimatedTokens > 200) return "complex";

  // Moderate indicators
  if (features.estimatedTokens > 150) return "moderate";
  if (features.hasMultiStepInstructions) return "moderate";
  if (features.messageCount > 3) return "moderate";

  // Default: trivial
  return "trivial";
}

export function classifyRequest(body: Record<string, unknown>): ClassificationResult {
  const features = extractFeatures(body);
  return { tier: classify(features), features };
}

// ---------------------------------------------------------------------------
// Routing Decision
// ---------------------------------------------------------------------------

export function makeRoutingDecision(
  config: RoutingConfig,
  body: Record<string, unknown>,
  originalProvider: string,
  headers: Record<string, string | string[] | undefined>
): RoutingDecision {
  const overrideHeader = config.override_header.toLowerCase();
  const forcedTier = headers[overrideHeader];

  if (typeof forcedTier === "string" && isValidTier(forcedTier)) {
    const target = config.routing_table[forcedTier];
    return {
      originalProvider,
      targetProvider: target.provider,
      targetModel: target.model,
      tier: forcedTier,
      forced: true,
    };
  }

  const classification = classifyRequest(body);
  const target = config.routing_table[classification.tier];

  return {
    originalProvider,
    targetProvider: target.provider,
    targetModel: target.model,
    tier: classification.tier,
    forced: false,
  };
}

function isValidTier(tier: string): tier is TaskTier {
  return tier === "trivial" || tier === "moderate" || tier === "complex";
}

// ---------------------------------------------------------------------------
// Escalation Triggers
// ---------------------------------------------------------------------------

/**
 * Checks whether the response should trigger an escalation to the next tier.
 * Returns the trigger name if escalation should happen, or null otherwise.
 */
export function checkEscalationTriggers(
  config: RoutingConfig,
  responseBody: Record<string, unknown>,
  _currentTier: TaskTier
): string | null {
  const triggers = config.escalation.trigger_on;

  // truncated_response: finish_reason is "length" (response hit max_tokens)
  if (triggers.includes("truncated_response")) {
    const choices = Array.isArray(responseBody.choices) ? responseBody.choices : [];
    for (const choice of choices) {
      if (
        typeof choice === "object" &&
        choice !== null &&
        (choice as Record<string, unknown>).finish_reason === "length"
      ) {
        return "truncated_response";
      }
    }
    // Anthropic stop_reason
    if (responseBody.stop_reason === "max_tokens") {
      return "truncated_response";
    }
  }

  // low_confidence: response body is very short or empty
  if (triggers.includes("low_confidence")) {
    const content = extractResponseText(responseBody);
    if (content !== null && content.trim().length < 10) {
      return "low_confidence";
    }
  }

  return null;
}

function extractResponseText(body: Record<string, unknown>): string | null {
  // OpenAI format
  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choice of choices) {
    if (typeof choice === "object" && choice !== null) {
      const msg = (choice as Record<string, unknown>).message;
      if (typeof msg === "object" && msg !== null) {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string") return content;
      }
    }
  }
  // Anthropic format
  const content = Array.isArray(body.content) ? body.content : [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Duplicate-retry tracker (in-memory, process-scoped)
// ---------------------------------------------------------------------------

const recentPromptHashes = new Map<string, number>(); // hash → timestamp
const DUPLICATE_WINDOW_MS = 10_000; // 10 seconds

export function isDuplicateRetry(body: Record<string, unknown>): boolean {
  const hash = simpleHash(JSON.stringify(body.messages ?? ""));
  const now = Date.now();
  const prev = recentPromptHashes.get(hash);

  // Clean up old entries periodically
  if (recentPromptHashes.size > 500) {
    for (const [k, v] of recentPromptHashes) {
      if (now - v > DUPLICATE_WINDOW_MS) recentPromptHashes.delete(k);
    }
  }

  if (prev && now - prev < DUPLICATE_WINDOW_MS) {
    recentPromptHashes.set(hash, now);
    return true;
  }

  recentPromptHashes.set(hash, now);
  return false;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}
