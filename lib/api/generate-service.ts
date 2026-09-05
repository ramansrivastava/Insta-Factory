import { generate } from "../generate/pipeline.ts";
import { LlmSchemaError, LlmTruncatedError } from "../llm/errors.ts";
import type { LlmAdapter } from "../llm/types.ts";
import { loadVoiceProfile } from "../voice/store.ts";
import type { GenerateSuccessBody } from "../../types/api.ts";

/**
 * The server-side half of `POST /api/generate`: load the voice profile, run the
 * Phase 3 pipeline, add one bounded retry, shape the response body.
 *
 * Generation logic itself is not here and must not move here — `generate()` in
 * `lib/generate/pipeline.ts` is the single implementation the CLI, the eval and
 * this route all share. What this module adds is the things only an HTTP caller
 * needs: a profile loaded from disk, a retry, and a serialisable body.
 */

/**
 * Two attempts total — the initial call plus exactly one retry.
 *
 * Bounded on purpose. A schema failure is sometimes a one-off (the model
 * emitted four hooks when five were asked for) and sometimes structural (the
 * idea keeps steering it into a shape the schema forbids). Retrying once
 * absorbs the first without turning the second into an unbounded spend on a
 * request nobody is watching.
 */
export const MAX_ATTEMPTS = 2;

export interface RunGenerationOptions {
  idea: string;
  hookCount: number;
  /** Injected by tests; production resolves the adapter from the environment. */
  adapter?: LlmAdapter;
  env?: Record<string, string | undefined>;
  /** Repo root the voice profile is read from. Injected by tests. */
  root?: string;
}

/**
 * Retryable failures are exactly the ones where the *same* request could
 * plausibly succeed on a second attempt: a malformed structure or a truncated
 * one. A refusal, a rate limit and an upstream 500 are not retried here — the
 * first will not change on a re-ask, and the other two need a wait rather than
 * an immediate second hit.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof LlmSchemaError || error instanceof LlmTruncatedError;
}

export async function runGeneration(
  options: RunGenerationOptions,
): Promise<GenerateSuccessBody> {
  // A fresh checkout has no data/voice-profile.json — it is gitignored personal
  // data — so fall back to the committed example rather than refusing to
  // generate. `usedExampleProfile` carries that fact to the UI so the creator
  // is told whose voice they are reading.
  const loaded = loadVoiceProfile({ fallbackToExample: true, root: options.root });

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await generate({
        idea: options.idea,
        profile: loaded.profile,
        hookCount: options.hookCount,
        adapter: options.adapter,
        env: options.env,
      });

      return {
        ok: true,
        // Normalised by the pipeline, and echoed back so the UI checks each
        // claim's quoted span against the text the model actually saw.
        idea: options.idea.trim(),
        hookCount: options.hookCount,
        hooks: result.hooks,
        script: result.script,
        meta: {
          ...result.meta,
          usedExampleProfile: loaded.usedExample,
          profileWarnings: loaded.warnings,
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
        console.warn(
          `[generate] attempt ${attempt} produced an unusable structure (${error instanceof Error ? error.message : String(error)}); retrying once.`,
        );
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop either returns or throws. Present so the function has
  // no implicit undefined path.
  throw lastError;
}
