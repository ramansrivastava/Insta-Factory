import { getAdapter } from "../llm/index.ts";
import { normalizeIdea } from "./idea.ts";
import type { LlmAdapter, StructuredResult } from "../llm/types.ts";
import { assertHookCount, buildHooksRequest } from "../prompts/hooks.ts";
import { buildScriptRequest } from "../prompts/script.ts";
import type { VoiceProfile } from "../../types/voice.ts";
import {
  DEFAULT_HOOK_COUNT,
  type GenerationResult,
  type Hook,
  type Script,
} from "../../types/generation.ts";

/**
 * The core loop: raw idea in, hooks plus a full script out.
 *
 * Two sequential calls rather than one, for three reasons:
 *   - the script call is conditioned on the hooks, so it can commit to one
 *     opening instead of writing a script that fits any of them;
 *   - the two calls need different prompts and different token budgets, and a
 *     single merged call would be one long prompt drifting through both;
 *   - regenerating only the hooks or only the script (Phase 8) is free with
 *     this shape and a rewrite with a monolithic call.
 *
 * Both calls open with a byte-identical cacheable prefix, so call 2 reads
 * call 1's cache.
 */

/**
 * Idea bounds and normalisation live in `./idea.ts` so the browser can import
 * them without pulling the LLM adapters in. Re-exported here because this is
 * where callers expect to find them.
 */
export {
  GenerationInputError,
  MAX_IDEA_LENGTH,
  MIN_IDEA_LENGTH,
  normalizeIdea,
} from "./idea.ts";

export interface GenerateInput {
  idea: string;
  profile: VoiceProfile;
  hookCount?: number;
  /** Injected by tests; production resolves the adapter from the environment. */
  adapter?: LlmAdapter;
  env?: Record<string, string | undefined>;
}

/**
 * Runs both calls in sequence and returns the combined result.
 *
 * Errors are not caught here: `LlmRefusalError`, `LlmSchemaError`,
 * `LlmRateLimitError` and friends carry the distinctions the API route (Phase 4)
 * needs to answer with a specific status code, and swallowing them into a
 * generic failure would throw that away.
 */
export async function generate(input: GenerateInput): Promise<GenerationResult> {
  const idea = normalizeIdea(input.idea);
  const hookCount = assertHookCount(input.hookCount ?? DEFAULT_HOOK_COUNT);
  const adapter = input.adapter ?? getAdapter(input.env);
  const startedAt = Date.now();

  const hooksResult = await adapter.generateStructured(
    buildHooksRequest({ idea, profile: input.profile, hookCount }),
  );
  const hooks: Hook[] = hooksResult.data.hooks;

  const scriptResult: StructuredResult<Script> = await adapter.generateStructured(
    buildScriptRequest({ idea, profile: input.profile, hooks }),
  );

  return {
    hooks,
    script: scriptResult.data,
    meta: {
      model: scriptResult.model,
      provider: scriptResult.provider,
      // Summed across both calls. Zero across repeated runs with an unchanged
      // profile means the cacheable prefix has started varying per request —
      // there is no error for that, only this number going flat.
      cacheReadTokens:
        hooksResult.usage.cacheReadInputTokens + scriptResult.usage.cacheReadInputTokens,
      // Wall clock for the pair, which is what the creator waits.
      latencyMs: Date.now() - startedAt,
    },
  };
}
