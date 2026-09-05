import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { AnthropicAdapter, buildSystemBlocks, toLlmError } from "@/lib/llm/adapters/anthropic.ts";
import {
  LlmRateLimitError,
  LlmRefusalError,
  LlmSchemaError,
  LlmTruncatedError,
  LlmUpstreamError,
} from "@/lib/llm/errors.ts";
import { buildProbeRequest } from "@/lib/llm/probe.ts";

/** Builds a fake SDK client whose `messages.parse` returns the given response. */
function clientReturning(response: unknown) {
  const parse = vi.fn().mockResolvedValue(response);
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}

const OK_RESPONSE = {
  stop_reason: "end_turn",
  stop_details: null,
  model: "claude-sonnet-5",
  parsed_output: {
    ok: true,
    provider_note: "live",
    items: ["a", "b"],
  },
  usage: {
    input_tokens: 120,
    output_tokens: 40,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 0,
  },
};

describe("buildSystemBlocks", () => {
  it("puts a cache breakpoint only on blocks flagged cacheable", () => {
    const blocks = buildSystemBlocks([
      { text: "stable", cacheable: true },
      { text: "volatile" },
    ]);

    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1]?.cache_control).toBeUndefined();
  });

  it("caps breakpoints at the API limit of four, keeping the longest prefix", () => {
    const blocks = buildSystemBlocks(
      Array.from({ length: 6 }, (_, index) => ({ text: `b${index}`, cacheable: true })),
    );
    const marked = blocks.filter((block) => block.cache_control !== undefined);

    expect(marked).toHaveLength(4);
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[5]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("AnthropicAdapter.generateStructured", () => {
  it("never sends temperature, top_p or top_k (removed on current models)", async () => {
    const { client, parse } = clientReturning(OK_RESPONSE);
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    await adapter.generateStructured(buildProbeRequest());

    const params = parse.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
  });

  it("ignores samplingHints rather than forwarding them to Anthropic", async () => {
    const { client, parse } = clientReturning(OK_RESPONSE);
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    await adapter.generateStructured({
      ...buildProbeRequest(),
      samplingHints: { temperature: 0.9, topP: 0.95, topK: 40 },
    });

    const params = parse.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("sends effort through output_config alongside the schema format", async () => {
    const { client, parse } = clientReturning(OK_RESPONSE);
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    await adapter.generateStructured({ ...buildProbeRequest(), effort: "xhigh" });

    const params = parse.mock.calls[0]?.[0];
    expect(params.output_config.effort).toBe("xhigh");
    expect(params.output_config.format).toBeDefined();
  });

  it("never uses an assistant prefill (400 on current models)", async () => {
    const { client, parse } = clientReturning(OK_RESPONSE);
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    await adapter.generateStructured(buildProbeRequest());

    const messages = parse.mock.calls[0]?.[0].messages;
    expect(messages.at(-1).role).toBe("user");
  });

  it("surfaces cache-read tokens so a silently broken cache is visible", async () => {
    const { client } = clientReturning(OK_RESPONSE);
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    const result = await adapter.generateStructured(buildProbeRequest());

    expect(result.usage.cacheReadInputTokens).toBe(90);
    expect(result.data.provider_note).toBe("live");
  });

  it("throws on a refusal before reading content", async () => {
    const { client } = clientReturning({
      ...OK_RESPONSE,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "nope" },
      parsed_output: null,
    });
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    await expect(adapter.generateStructured(buildProbeRequest())).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
  });

  it("throws when the response was truncated by max_tokens", async () => {
    const { client } = clientReturning({ ...OK_RESPONSE, stop_reason: "max_tokens" });
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    await expect(adapter.generateStructured(buildProbeRequest())).rejects.toBeInstanceOf(
      LlmTruncatedError,
    );
  });

  it("throws when the payload does not match the schema", async () => {
    const { client } = clientReturning({ ...OK_RESPONSE, parsed_output: { ok: true } });
    const adapter = new AnthropicAdapter({ apiKey: "sk-test", client });

    await expect(adapter.generateStructured(buildProbeRequest())).rejects.toBeInstanceOf(
      LlmSchemaError,
    );
  });
});

describe("toLlmError", () => {
  it("maps a rate limit to LlmRateLimitError with retry-after", () => {
    const headers = new Headers({ "retry-after": "12" });
    const error = new Anthropic.RateLimitError(429, {}, "slow down", headers);

    const mapped = toLlmError(error, "probe");

    expect(mapped).toBeInstanceOf(LlmRateLimitError);
    expect((mapped as LlmRateLimitError).retryAfterSeconds).toBe(12);
  });

  it("maps a 404 to an upstream error carrying the status", () => {
    const error = new Anthropic.NotFoundError(404, {}, "no such model", new Headers());

    const mapped = toLlmError(error, "probe");

    expect(mapped).toBeInstanceOf(LlmUpstreamError);
    expect((mapped as LlmUpstreamError).status).toBe(404);
  });

  it("maps a connection failure to an upstream error with no status", () => {
    const error = new Anthropic.APIConnectionError({ message: "socket hang up" });

    const mapped = toLlmError(error, "probe");

    expect(mapped).toBeInstanceOf(LlmUpstreamError);
    expect((mapped as LlmUpstreamError).status).toBeNull();
  });

  it("maps a generic API error to an upstream error", () => {
    const error = new Anthropic.InternalServerError(500, {}, "boom", new Headers());

    expect(toLlmError(error, "probe")).toBeInstanceOf(LlmUpstreamError);
  });
});
