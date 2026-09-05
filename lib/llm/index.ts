import { AnthropicAdapter, DEFAULT_MODEL } from "./adapters/anthropic.ts";
import { MOCK_MODEL, MockAdapter } from "./adapters/mock.ts";
import { LlmConfigError } from "./errors.ts";
import type { LlmAdapter, LlmProvider } from "./types.ts";

export * from "./errors.ts";
export * from "./types.ts";
export { AnthropicAdapter, DEFAULT_MODEL } from "./adapters/anthropic.ts";
export { MOCK_MODEL, MockAdapter } from "./adapters/mock.ts";

type Env = Record<string, string | undefined>;

let warnedAboutMissingKey = false;

/**
 * Decides which provider to use.
 *
 * The rule is "never crash for want of an API key": with no key we fall back to
 * the deterministic mock so `npm run build`, the smoke test and the Layer-1
 * eval all pass on a clean checkout and in CI.
 */
export function resolveProvider(env: Env = process.env): LlmProvider {
  const requested = env.LLM_PROVIDER?.trim().toLowerCase();
  const hasKey = Boolean(env.ANTHROPIC_API_KEY?.trim());

  if (requested === "mock") return "mock";

  if (requested === "anthropic") {
    if (hasKey) return "anthropic";
    if (!warnedAboutMissingKey) {
      warnedAboutMissingKey = true;
      console.warn(
        "[llm] LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset — falling back to the mock provider.",
      );
    }
    return "mock";
  }

  if (requested && requested !== "anthropic" && requested !== "mock") {
    throw new LlmConfigError(
      `Unknown LLM_PROVIDER "${env.LLM_PROVIDER}". Expected "anthropic" or "mock".`,
    );
  }

  return hasKey ? "anthropic" : "mock";
}

/** Model the resolved provider will report and use. */
export function resolveModel(env: Env = process.env): string {
  return resolveProvider(env) === "mock"
    ? MOCK_MODEL
    : env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Single construction point for the LLM client. Callers depend on the
 * `LlmAdapter` interface only, never on a concrete provider.
 */
export function getAdapter(env: Env = process.env): LlmAdapter {
  if (resolveProvider(env) === "mock") {
    return new MockAdapter();
  }
  return new AnthropicAdapter({
    apiKey: env.ANTHROPIC_API_KEY as string,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  });
}
