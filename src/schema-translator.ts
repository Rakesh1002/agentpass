/**
 * Cross-Provider Schema Translation (Section 3.5)
 *
 * Converts single-turn, non-streaming chat completion requests between
 * OpenAI Chat Completions and Anthropic Messages schemas, and maps
 * responses back to the original shape.
 *
 * Limitations (per report):
 *  - Tool/function-calling payloads are NOT supported
 *  - Streaming responses are NOT supported
 *  - Multi-modal (image) content is NOT supported
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: unknown[];
  functions?: unknown[];
  [key: string]: unknown;
}

export interface OpenAIChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface AnthropicContentBlock {
  type: "text";
  text: string;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Translation eligibility
// ---------------------------------------------------------------------------

/**
 * Returns true if the request body can be translated.
 * Returns false for streaming, tool/function-calling, or multi-modal requests.
 */
export function canTranslate(body: Record<string, unknown>): boolean {
  // Streaming is not supported
  if (body.stream === true) return false;

  // Tool/function calling is not supported
  if (Array.isArray(body.tools) && body.tools.length > 0) return false;
  if (Array.isArray(body.functions) && body.functions.length > 0) return false;

  // Multi-modal content (array-typed content blocks) is not supported
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (typeof msg === "object" && msg !== null) {
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) return false; // multi-modal content blocks
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// OpenAI → Anthropic
// ---------------------------------------------------------------------------

/**
 * Converts an OpenAI Chat Completions request body into an Anthropic
 * Messages request body.
 *
 * Key differences handled:
 *  - OpenAI puts system messages inline; Anthropic uses a top-level `system` field
 *  - Model name is replaced with the target model from the routing table
 *  - max_tokens is required by Anthropic (defaults to 4096)
 */
export function translateOpenAIToAnthropic(
  body: OpenAIRequest,
  targetModel: string
): AnthropicRequest {
  const messages: AnthropicMessage[] = [];
  let systemPrompt = "";

  for (const msg of body.messages) {
    if (msg.role === "system") {
      // Anthropic uses top-level system field, not a system message
      systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
    } else {
      messages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }
  }

  const result: AnthropicRequest = {
    model: targetModel,
    messages,
    max_tokens: body.max_tokens ?? 4096,
  };

  if (systemPrompt) {
    result.system = systemPrompt;
  }

  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  if (body.top_p !== undefined) {
    result.top_p = body.top_p;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Anthropic → OpenAI (response mapping)
// ---------------------------------------------------------------------------

/**
 * Converts an Anthropic Messages response into OpenAI Chat Completions
 * response shape so the calling agent sees the format it expects.
 */
export function translateAnthropicResponseToOpenAI(
  response: AnthropicResponse
): OpenAIResponse {
  const contentText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const finishReason = mapStopReason(response.stop_reason);

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: contentText,
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic → OpenAI (request, for reverse routing)
// ---------------------------------------------------------------------------

/**
 * Converts an Anthropic Messages request body into an OpenAI Chat
 * Completions request body.
 */
export function translateAnthropicToOpenAI(
  body: AnthropicRequest,
  targetModel: string
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // Anthropic system field → OpenAI system message
  if (body.system) {
    messages.push({ role: "system", content: body.system });
  }

  for (const msg of body.messages) {
    messages.push({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : "",
    });
  }

  const result: OpenAIRequest = {
    model: targetModel,
    messages,
  };

  if (body.max_tokens !== undefined) {
    result.max_tokens = body.max_tokens;
  }
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    result.top_p = body.top_p;
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI → Anthropic (response mapping, for reverse routing)
// ---------------------------------------------------------------------------

/**
 * Converts an OpenAI Chat Completions response into Anthropic Messages
 * response shape.
 */
export function translateOpenAIResponseToAnthropic(
  response: OpenAIResponse
): AnthropicResponse {
  const choice = response.choices[0];
  const contentText = choice?.message?.content ?? "";
  const stopReason = mapFinishReason(choice?.finish_reason);

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: contentText }],
    model: response.model,
    stop_reason: stopReason,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(
  reason: AnthropicResponse["stop_reason"]
): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    default:
      return "stop";
  }
}

function mapFinishReason(
  reason: string | undefined
): AnthropicResponse["stop_reason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

/**
 * Detects whether a request body looks like an OpenAI Chat Completions
 * request vs an Anthropic Messages request.
 */
export function detectRequestFormat(body: Record<string, unknown>): "openai" | "anthropic" | "unknown" {
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // Anthropic: has top-level `system` field or messages never include role="system"
  if (typeof body.system === "string") return "anthropic";

  // OpenAI: messages may include role="system"
  for (const msg of messages) {
    if (typeof msg === "object" && msg !== null) {
      if ((msg as Record<string, unknown>).role === "system") return "openai";
    }
  }

  // Heuristic: if max_tokens is set and there's no `system` field,
  // and the model name starts with "claude", it's Anthropic
  if (typeof body.model === "string" && (body.model as string).startsWith("claude")) {
    return "anthropic";
  }

  // Default to OpenAI (most common)
  return "openai";
}
