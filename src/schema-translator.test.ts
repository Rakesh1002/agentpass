import { describe, expect, test } from "bun:test";
import {
  canTranslate,
  translateOpenAIToAnthropic,
  translateAnthropicToOpenAI,
  translateAnthropicResponseToOpenAI,
  translateOpenAIResponseToAnthropic,
  detectRequestFormat,
  type OpenAIRequest,
  type OpenAIResponse,
  type AnthropicRequest,
  type AnthropicResponse,
} from "./schema-translator";

describe("schema translator — eligibility", () => {
  test("accepts single-turn, non-streaming request", () => {
    expect(
      canTranslate({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      })
    ).toBe(true);
  });

  test("rejects streaming request", () => {
    expect(
      canTranslate({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      })
    ).toBe(false);
  });

  test("rejects tool-calling request", () => {
    expect(
      canTranslate({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "test" } }],
      })
    ).toBe(false);
  });

  test("rejects multi-modal content (array content blocks)", () => {
    expect(
      canTranslate({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "..." } },
            ],
          },
        ],
      })
    ).toBe(false);
  });
});

describe("schema translator — OpenAI → Anthropic", () => {
  test("translates basic request", () => {
    const input: OpenAIRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      temperature: 0.7,
    };

    const result = translateOpenAIToAnthropic(input, "claude-3-5-sonnet");

    expect(result.model).toBe("claude-3-5-sonnet");
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(result.max_tokens).toBe(100);
    expect(result.temperature).toBe(0.7);
    expect(result.system).toBeUndefined();
  });

  test("extracts system message into top-level system field", () => {
    const input: OpenAIRequest = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
    };

    const result = translateOpenAIToAnthropic(input, "claude-3-5-sonnet");

    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
    // System message should NOT be in messages array
    expect(result.messages.some((m) => m.role === ("system" as string))).toBe(false);
  });

  test("defaults max_tokens to 4096 when not specified", () => {
    const input: OpenAIRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = translateOpenAIToAnthropic(input, "claude-3-5-sonnet");
    expect(result.max_tokens).toBe(4096);
  });
});

describe("schema translator — Anthropic → OpenAI", () => {
  test("translates basic request", () => {
    const input: AnthropicRequest = {
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 200,
      system: "Be concise.",
    };

    const result = translateAnthropicToOpenAI(input, "gpt-4o-mini");

    expect(result.model).toBe("gpt-4o-mini");
    expect(result.messages[0]).toEqual({ role: "system", content: "Be concise." });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(result.max_tokens).toBe(200);
  });
});

describe("schema translator — Anthropic response → OpenAI", () => {
  test("maps content blocks and stop_reason", () => {
    const input: AnthropicResponse = {
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello back!" }],
      model: "claude-3-5-sonnet",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = translateAnthropicResponseToOpenAI(input);

    expect(result.id).toBe("msg_123");
    expect(result.object).toBe("chat.completion");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0]?.message.content).toBe("Hello back!");
    expect(result.choices[0]?.finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  test("maps max_tokens stop_reason to length finish_reason", () => {
    const input: AnthropicResponse = {
      id: "msg_456",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Truncated..." }],
      model: "claude-3-5-sonnet",
      stop_reason: "max_tokens",
      usage: { input_tokens: 50, output_tokens: 100 },
    };

    const result = translateAnthropicResponseToOpenAI(input);
    expect(result.choices[0]?.finish_reason).toBe("length");
  });
});

describe("schema translator — OpenAI response → Anthropic", () => {
  test("maps choices and finish_reason", () => {
    const input: OpenAIResponse = {
      id: "chatcmpl-789",
      object: "chat.completion",
      created: 1234567890,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Sure thing!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };

    const result = translateOpenAIResponseToAnthropic(input);

    expect(result.id).toBe("chatcmpl-789");
    expect(result.type).toBe("message");
    expect(result.content).toEqual([{ type: "text", text: "Sure thing!" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(20);
    expect(result.usage.output_tokens).toBe(10);
  });
});

describe("schema translator — format detection", () => {
  test("detects OpenAI format (system role in messages)", () => {
    expect(
      detectRequestFormat({
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hi" },
        ],
      })
    ).toBe("openai");
  });

  test("detects Anthropic format (top-level system field)", () => {
    expect(
      detectRequestFormat({
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hi" }],
      })
    ).toBe("anthropic");
  });

  test("detects Anthropic format by model name", () => {
    expect(
      detectRequestFormat({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "Hi" }],
      })
    ).toBe("anthropic");
  });

  test("defaults to openai for ambiguous requests", () => {
    expect(
      detectRequestFormat({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      })
    ).toBe("openai");
  });
});
