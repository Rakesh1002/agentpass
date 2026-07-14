import { describe, expect, test } from "bun:test";
import {
  classifyRequest,
  classify,
  extractFeatures,
  makeRoutingDecision,
  checkEscalationTriggers,
  nextTier,
  isDuplicateRetry,
  type RoutingConfig,
  type TaskTier,
} from "./router";

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

describe("router — feature extraction", () => {
  test("estimates tokens from message content", () => {
    const features = extractFeatures({
      messages: [{ role: "user", content: "Hello world" }],
    });
    expect(features.estimatedTokens).toBeGreaterThan(0);
    expect(features.hasCodeFences).toBe(false);
    expect(features.hasMathNotation).toBe(false);
    expect(features.hasMultiStepInstructions).toBe(false);
    expect(features.messageCount).toBe(1);
  });

  test("detects code fences", () => {
    const features = extractFeatures({
      messages: [
        { role: "user", content: "Fix this:\n```python\nprint('hello')\n```" },
      ],
    });
    expect(features.hasCodeFences).toBe(true);
  });

  test("detects math notation", () => {
    const features = extractFeatures({
      messages: [
        { role: "user", content: "Compute \\frac{1}{2} + \\sum_{i=1}^{n} x_i" },
      ],
    });
    expect(features.hasMathNotation).toBe(true);
  });

  test("detects multi-step instructions", () => {
    const features = extractFeatures({
      messages: [
        {
          role: "user",
          content:
            "Step 1: download the file. Step 2: parse the JSON. Step 3: aggregate results.",
        },
      ],
    });
    expect(features.hasMultiStepInstructions).toBe(true);
  });
});

describe("router — classifier", () => {
  test("classifies short extraction as trivial", () => {
    const result = classifyRequest({
      messages: [{ role: "user", content: "What is 2+2?" }],
    });
    expect(result.tier).toBe("trivial");
  });

  test("classifies code generation as complex", () => {
    const result = classifyRequest({
      messages: [
        {
          role: "user",
          content:
            "Write a function:\n```typescript\nfunction sort(arr: number[]): number[] {\n  // implementation\n}\n```",
        },
      ],
    });
    expect(result.tier).toBe("complex");
  });

  test("classifies moderate-length prose as moderate", () => {
    const longContent = "Summarize the following article. ".repeat(40);
    const result = classifyRequest({
      messages: [{ role: "user", content: longContent }],
    });
    expect(["moderate", "complex"]).toContain(result.tier);
  });

  test("classifies multi-turn conversation as moderate", () => {
    const result = classifyRequest({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "How are you?" },
      ],
    });
    // 4 messages → moderate
    expect(result.tier).toBe("moderate");
  });
});

describe("router — routing decision", () => {
  test("routes trivial request to groq", () => {
    const decision = makeRoutingDecision(
      DEFAULT_CONFIG,
      { messages: [{ role: "user", content: "Hi" }] },
      "openai",
      {}
    );
    expect(decision.tier).toBe("trivial");
    expect(decision.targetProvider).toBe("groq");
    expect(decision.targetModel).toBe("llama3-8b");
    expect(decision.forced).toBe(false);
  });

  test("respects X-AgentPass-Force-Tier header", () => {
    const decision = makeRoutingDecision(
      DEFAULT_CONFIG,
      { messages: [{ role: "user", content: "Hi" }] },
      "openai",
      { "x-agentpass-force-tier": "complex" }
    );
    expect(decision.tier).toBe("complex");
    expect(decision.targetProvider).toBe("anthropic");
    expect(decision.forced).toBe(true);
  });

  test("ignores invalid force-tier value", () => {
    const decision = makeRoutingDecision(
      DEFAULT_CONFIG,
      { messages: [{ role: "user", content: "Hi" }] },
      "openai",
      { "x-agentpass-force-tier": "invalid-tier" }
    );
    // Should fall back to classification
    expect(decision.forced).toBe(false);
  });
});

describe("router — tier escalation", () => {
  test("nextTier returns the next tier up", () => {
    expect(nextTier("trivial")).toBe("moderate");
    expect(nextTier("moderate")).toBe("complex");
    expect(nextTier("complex")).toBeNull();
  });

  test("detects truncated_response trigger (OpenAI format)", () => {
    const trigger = checkEscalationTriggers(
      DEFAULT_CONFIG,
      {
        choices: [{ index: 0, message: { role: "assistant", content: "..." }, finish_reason: "length" }],
      },
      "trivial"
    );
    expect(trigger).toBe("truncated_response");
  });

  test("detects truncated_response trigger (Anthropic format)", () => {
    const trigger = checkEscalationTriggers(
      DEFAULT_CONFIG,
      {
        content: [{ type: "text", text: "..." }],
        stop_reason: "max_tokens",
      },
      "trivial"
    );
    expect(trigger).toBe("truncated_response");
  });

  test("detects low_confidence trigger", () => {
    const trigger = checkEscalationTriggers(
      DEFAULT_CONFIG,
      {
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      },
      "trivial"
    );
    expect(trigger).toBe("low_confidence");
  });

  test("returns null when no escalation needed", () => {
    const trigger = checkEscalationTriggers(
      DEFAULT_CONFIG,
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "This is a perfectly good response with enough content." },
            finish_reason: "stop",
          },
        ],
      },
      "trivial"
    );
    expect(trigger).toBeNull();
  });
});

describe("router — duplicate retry detection", () => {
  test("detects duplicate prompts within time window", () => {
    const body = { messages: [{ role: "user", content: "unique-test-" + Date.now() }] };
    const first = isDuplicateRetry(body);
    const second = isDuplicateRetry(body);
    expect(first).toBe(false); // First time is not a duplicate
    expect(second).toBe(true); // Second time within window IS a duplicate
  });
});
