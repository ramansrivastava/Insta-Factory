import {
  generate,
  regenerateHooks,
  regenerateScript,
} from "../generate/pipeline.ts";
import { errorFields, generationLogger, newGenerationId } from "../log.ts";
import { LlmSchemaError, LlmTruncatedError } from "../llm/errors.ts";
import type { LlmAdapter } from "../llm/types.ts";
import type { Hook, RegenerationTarget } from "../../types/generation.ts";
import { loadVoiceProfile } from "../voice/store.ts";
import type { GenerateSuccessBody, RegenerateSuccessBody } from "../../types/api.ts";

/**
 * The server-side half of `POST /api/generate` and `POST /api/regenerate`: load
 * the voice profile, run the Phase 3 pipeline (whole, or one half of it), add
 * one bounded retry, shape the response body.
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
  /**
   * Trace id minted by the caller at request entry. Passed down so the retry,
   * the two model calls and the JSONL record all share one id — a retry that
   * logged under a fresh id would read as two unrelated generations.
   */
  generationId?: string;
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
  const generationId = options.generationId ?? newGenerationId();
  const log = generationLogger(generationId);

  // A fresh checkout has no data/voice-profile.json — it is gitignored personal
  // data — so fall back to the committed example rather than refusing to
  // generate. `usedExampleProfile` carries that fact to the UI so the creator
  // is told whose voice they are reading.
  const loaded = loadVoiceProfile({ fallbackToExample: true, root: options.root });
  if (loaded.usedExample) {
    log.warn(
      { event: "profile.fallback", path: loaded.path },
      "no saved voice profile — generating in the example profile's voice",
    );
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await generate({
        idea: options.idea,
        profile: loaded.profile,
        hookCount: options.hookCount,
        adapter: options.adapter,
        env: options.env,
        generationId,
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
        log.warn(
          { event: "generation.retry", attempt, max_attempts: MAX_ATTEMPTS, err: errorFields(error) },
          "attempt produced an unusable structure — retrying once",
        );
        continue;
      }
      log.error(
        { event: "generation.failed", attempt, err: errorFields(error) },
        "generation failed",
      );
      throw error;
    }
  }

  // Unreachable: the loop either returns or throws. Present so the function has
  // no implicit undefined path.
  throw lastError;
}

export interface RunRegenerationOptions {
  target: RegenerationTarget;
  idea: string;
  hookCount: number;
  /** The generation the creator pressed the button on. */
  parentGenerationId: string;
  /**
   * Avoid-context when `target` is `"hooks"`; the hooks the new script must
   * open with when it is `"script"`. Same field either way because it is the
   * same thing from the client's side: the hooks currently on screen.
   */
  hooks: readonly Hook[];
  steer?: string;
  adapter?: LlmAdapter;
  env?: Record<string, string | undefined>;
  root?: string;
  generationId?: string;
}

/**
 * The server-side half of `POST /api/regenerate`.
 *
 * Same shape as `runGeneration` — profile off disk, one bounded retry, a
 * serialisable body — and for the same reasons. The retry matters slightly more
 * here: a regeneration is already the creator's second ask, and making them
 * press the button a third time because the model returned four hooks instead
 * of five is the interaction this feature exists to prevent.
 */
export async function runRegeneration(
  options: RunRegenerationOptions,
): Promise<RegenerateSuccessBody> {
  const generationId = options.generationId ?? newGenerationId();
  const log = generationLogger(generationId);

  const loaded = loadVoiceProfile({ fallbackToExample: true, root: options.root });
  if (loaded.usedExample) {
    log.warn(
      { event: "profile.fallback", path: loaded.path },
      "no saved voice profile — regenerating in the example profile's voice",
    );
  }

  const common = {
    idea: options.idea,
    profile: loaded.profile,
    parentGenerationId: options.parentGenerationId,
    steer: options.steer,
    adapter: options.adapter,
    env: options.env,
    generationId,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result =
        options.target === "hooks"
          ? await regenerateHooks({
              ...common,
              hookCount: options.hookCount,
              avoid: options.hooks,
            })
          : await regenerateScript({ ...common, hooks: options.hooks });

      return {
        ok: true,
        target: result.target,
        idea: options.idea.trim(),
        hookCount: options.hookCount,
        hooks: result.hooks,
        script: result.script,
        checks: result.checks.map((check) => ({
          name: check.name,
          passed: check.passed,
          score: check.score,
          details: check.details,
        })),
        meta: {
          ...result.meta,
          usedExampleProfile: loaded.usedExample,
          profileWarnings: loaded.warnings,
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
        log.warn(
          {
            event: "regeneration.retry",
            target: options.target,
            attempt,
            max_attempts: MAX_ATTEMPTS,
            err: errorFields(error),
          },
          "attempt produced an unusable structure — retrying once",
        );
        continue;
      }
      log.error(
        { event: "regeneration.failed", target: options.target, attempt, err: errorFields(error) },
        "regeneration failed",
      );
      throw error;
    }
  }

  throw lastError;
}
