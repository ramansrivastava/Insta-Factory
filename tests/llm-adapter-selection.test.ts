import { describe, expect, it } from "vitest";

import { LlmConfigError } from "@/lib/llm/errors.ts";
import { DEFAULT_MODEL, getAdapter, resolveModel, resolveProvider } from "@/lib/llm/index.ts";
import { MOCK_MODEL } from "@/lib/llm/adapters/mock.ts";

describe("resolveProvider", () => {
  it("defaults to mock when no API key is present", () => {
    expect(resolveProvider({})).toBe("mock");
  });

  it("uses anthropic when a key is present and no provider is pinned", () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: "sk-test" })).toBe("anthropic");
  });

  it("honours an explicit mock pin even when a key is present", () => {
    expect(
      resolveProvider({ ANTHROPIC_API_KEY: "sk-test", LLM_PROVIDER: "mock" }),
    ).toBe("mock");
  });

  it("falls back to mock rather than crashing when anthropic is pinned without a key", () => {
    expect(resolveProvider({ LLM_PROVIDER: "anthropic" })).toBe("mock");
  });

  it("treats a blank key as absent", () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: "   " })).toBe("mock");
  });

  it("rejects an unknown provider", () => {
    expect(() => resolveProvider({ LLM_PROVIDER: "openai" })).toThrow(LlmConfigError);
  });
});

describe("resolveModel", () => {
  it("reports the fixture model when running on the mock", () => {
    expect(resolveModel({})).toBe(MOCK_MODEL);
  });

  it("defaults to claude-sonnet-5 for the anthropic provider", () => {
    expect(resolveModel({ ANTHROPIC_API_KEY: "sk-test" })).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
  });

  it("honours LLM_MODEL", () => {
    expect(
      resolveModel({ ANTHROPIC_API_KEY: "sk-test", LLM_MODEL: "claude-opus-5" }),
    ).toBe("claude-opus-5");
  });
});

describe("getAdapter", () => {
  it("builds a mock adapter with no key", () => {
    expect(getAdapter({}).provider).toBe("mock");
  });

  it("builds an anthropic adapter with a key", () => {
    const adapter = getAdapter({ ANTHROPIC_API_KEY: "sk-test" });
    expect(adapter.provider).toBe("anthropic");
    expect(adapter.model).toBe(DEFAULT_MODEL);
  });
});
