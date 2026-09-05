import type { Logger } from "pino";

import { getAdapter } from "../llm/index.ts";
import { normalizeIdea } from "./idea.ts";
import { runLayer1Checks, type CheckResult } from "./checks.ts";
import {
  callFields,
  errorFields,
  generationLogger,
  newGenerationId,
  type GenerationPhase,
} from "../log.ts";
import {
  appendTraceRecord,
  profileHash,
  tracingEnabled,
  type GenerationRecord,
  type TraceStoreOptions,
} from "../generations/store.ts";
import type { LlmAdapter, LlmUsage, StructuredResult } from "../llm/types.ts";
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
 *
 * Every boundary here is logged against a single `generation_id` minted at
 * entry, and the whole run is appended to `data/generations/<date>.jsonl`. That
 * instrumentation is not decoration: this pipeline's only externally visible
 * failure mode is *quiet* — a prompt-cache prefix that silently stops matching,
 * or output that drifts out of the creator's voice, both look exactly like
 * success from the outside.
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
  /**
   * Trace id, when the caller minted one earlier. The API route does, so that
   * the log line for a rejected request carries the same id as the one that
   * would have carried a result.
   */
  generationId?: string;
  /** Parent logger. Defaults to the process logger from `lib/log.ts`. */
  logger?: Logger;
  /** Where the JSONL trace lands, and whether it is written at all. */
  trace?: TraceStoreOptions & { enabled?: boolean };
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

/**
 * Runs both calls in sequence and returns the combined result.
 *
 * Errors are not caught here: `LlmRefusalError`, `LlmSchemaError`,
 * `LlmRateLimitError` and friends carry the distinctions the API route needs to
 * answer with a specific status code, and swallowing them into a generic
 * failure would throw that away. They are *logged* and rethrown, which is a
 * different thing — the log line is where the provider's own message survives,
 * since the client only ever sees the sentence written for a human.
 */
export async function generate(input: GenerateInput): Promise<GenerationResult> {
  const generationId = input.generationId ?? newGenerationId();
  const log = generationLogger(generationId, input.logger);

  // Input validation before anything else, and logged: a rejected idea is the
  // single most common non-success outcome and it should not be invisible.
  let idea: string;
  let hookCount: number;
  try {
    idea = normalizeIdea(input.idea);
    hookCount = assertHookCount(input.hookCount ?? DEFAULT_HOOK_COUNT);
  } catch (error) {
    log.warn(
      { event: "generation.rejected", err: errorFields(error) },
      "generation rejected before any model call",
    );
    throw error;
  }

  const adapter = input.adapter ?? getAdapter(input.env);
  const hash = profileHash(input.profile);
  const base = { provider: adapter.provider, model: adapter.model };

  log.info(
    {
      event: "generation.received",
      ...base,
      hook_count: hookCount,
      idea_length: idea.length,
      profile_hash: hash,
      // The idea itself goes to the JSONL trace, not to the log line: logs are
      // the thing most likely to be shipped somewhere else, and the creator's
      // unpublished ideas are the most private data this product holds.
      example_count: input.profile.examples.length,
    },
    "generation received",
  );

  const startedAt = Date.now();

  const hooksResult = await callPhase(log, base, "hooks", () =>
    adapter.generateStructured(buildHooksRequest({ idea, profile: input.profile, hookCount })),
  );
  const hooks: Hook[] = hooksResult.data.hooks;

  const scriptResult: StructuredResult<Script> = await callPhase(log, base, "script", () =>
    adapter.generateStructured(buildScriptRequest({ idea, profile: input.profile, hooks })),
  );

  const latencyMs = Date.now() - startedAt;
  const usage = addUsage(hooksResult.usage, scriptResult.usage);

  // Layer 1 runs here rather than only in the eval, so that every real
  // generation — not just the ones a harness looks at — leaves a per-check
  // pass/fail record behind. This is what makes the trace usable as calibration
  // data later instead of just as a debugging aid.
  const checks = runLayer1Checks({
    idea,
    hooks,
    script: scriptResult.data,
    hookCount,
    bannedPhrases: input.profile.traits.banned_phrases,
  });
  logChecks(log, checks);

  const result: GenerationResult = {
    hooks,
    script: scriptResult.data,
    checks,
    meta: {
      generationId,
      model: scriptResult.model,
      provider: scriptResult.provider,
      // Summed across both calls. Zero across repeated runs with an unchanged
      // profile means the cacheable prefix has started varying per request —
      // there is no error for that, only this number going flat.
      cacheReadTokens: usage.cacheReadInputTokens,
      // Wall clock for the pair, which is what the creator waits.
      latencyMs,
    },
  };

  recordTrace(log, input, {
    type: "generation",
    generation_id: generationId,
    recorded_at: new Date().toISOString(),
    idea,
    hook_count: hookCount,
    profile_hash: hash,
    provider: scriptResult.provider,
    model: scriptResult.model,
    hooks,
    script: scriptResult.data,
    checks: checks.map((check) => ({
      name: check.name,
      passed: check.passed,
      score: check.score,
      details: check.details,
    })),
    timings: {
      total_ms: latencyMs,
      hooks_ms: hooksResult.latencyMs,
      script_ms: scriptResult.latencyMs,
    },
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
    },
  });

  log.info(
    {
      event: "generation.completed",
      ...base,
      latency_ms: latencyMs,
      hook_count: hooks.length,
      section_count: scriptResult.data.sections.length,
      claim_count: scriptResult.data.claims.length,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      checks_failed: checks.filter((check) => !check.passed).length,
    },
    "generation completed",
  );

  return result;
}

/** One LLM call, bracketed by an issued line and a returned-or-failed line. */
async function callPhase<T>(
  log: Logger,
  base: { provider: string; model: string },
  phase: GenerationPhase,
  run: () => Promise<StructuredResult<T>>,
): Promise<StructuredResult<T>> {
  log.info({ event: "llm.call.issued", ...base, phase }, `${phase} call issued`);
  const startedAt = Date.now();

  try {
    const result = await run();
    log.info(
      { event: "llm.call.returned", ...callFields(phase, result) },
      `${phase} call returned`,
    );
    return result;
  } catch (error) {
    log.error(
      {
        event: "llm.call.failed",
        ...base,
        phase,
        latency_ms: Date.now() - startedAt,
        err: errorFields(error),
      },
      `${phase} call failed`,
    );
    throw error;
  }
}

/**
 * One line carrying every check's verdict, plus a warning per failure.
 *
 * Both, not either: the summary line is what makes pass rates countable across
 * runs, and the per-failure warning is what makes a single bad generation
 * findable without parsing an array out of an info line.
 */
function logChecks(log: Logger, checks: CheckResult[]): void {
  log.info(
    {
      event: "checks.run",
      checks: checks.map((check) => ({
        name: check.name,
        passed: check.passed,
        score: check.score,
      })),
      checks_failed: checks.filter((check) => !check.passed).length,
    },
    "layer-1 checks run",
  );

  for (const check of checks) {
    if (check.passed) continue;
    log.warn(
      { event: "check.failed", check: check.name, details: check.details },
      `layer-1 check failed: ${check.name}`,
    );
  }
}

/** Appends the trace record, unless tracing is switched off for this run. */
function recordTrace(log: Logger, input: GenerateInput, record: GenerationRecord): void {
  const enabled = input.trace?.enabled ?? tracingEnabled(input.env);
  if (!enabled) return;

  const outcome = appendTraceRecord(record, input.trace);
  if (outcome.written) {
    log.debug({ event: "trace.written", file: outcome.file }, "generation trace written");
    return;
  }

  // A trace that cannot be written is worth a loud line and nothing more: the
  // generation itself already succeeded and the creator is owed their script.
  log.error(
    { event: "trace.write_failed", file: outcome.file, err: errorFields(outcome.error) },
    "could not append the generation trace",
  );
}
