import type { Logger } from "pino";

import { getAdapter } from "../llm/index.ts";
import { GenerationInputError, normalizeIdea, normalizeSteer } from "./idea.ts";
import {
  runHookChecks,
  runLayer1Checks,
  runScriptChecks,
  type CheckResult,
} from "./checks.ts";
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
  type GenerationMeta,
  type GenerationResult,
  type Hook,
  type RegenerationTarget,
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
  normalizeSteer,
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
function recordTrace(
  log: Logger,
  input: Pick<GenerateInput, "env" | "trace">,
  record: GenerationRecord,
): void {
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


/*
 * Regeneration — re-running one half of a generation.
 *
 * This is the payoff for the two-call shape above. "Give me different hooks"
 * costs one call and leaves the script alone; "rewrite the script" costs one
 * call and leaves the hooks the creator was still choosing between on screen.
 * With a single merged call, either request would have meant paying for both
 * halves and throwing away the one that was already fine.
 *
 * Two things make a regeneration more than a re-run:
 *
 *   - **Avoid-context.** The same idea, profile and angle menu produce the same
 *     neighbourhood of hooks, so a naive re-run reads as round one reworded.
 *     The rejected hooks are handed back to the model explicitly (see
 *     `renderAvoidHooks`), which is what makes round two a genuinely different
 *     set.
 *   - **The steer.** One optional line of adjustment, appended to the *user
 *     turn*. Never to a system block: the voice prefix is the cached part, and
 *     a steer above the last cache breakpoint would invalidate it on every
 *     press of the button, doubling the input cost of the exact interaction
 *     this feature exists to make cheap.
 *
 * Every regeneration is its own record with its own `generation_id`, carrying
 * `parent_generation_id`. That is deliberate: overwriting the parent's record
 * would erase the evidence that a second attempt was needed at all, and the
 * count of second attempts is the dissatisfaction signal accept/edit/discard
 * cannot produce.
 */

interface RegenerateCommon {
  idea: string;
  profile: VoiceProfile;
  /**
   * The generation this one was launched from. Recorded, never re-read.
   *
   * Optional because the same two entry points serve `npm run generate
   * --hooks-only`, which runs half the pipeline without a previous attempt to
   * be dissatisfied with. A record with a target but no parent is a half run;
   * a record with both is a regeneration, and only the second one counts
   * towards "she had to ask twice".
   */
  parentGenerationId?: string;
  /** The creator's optional one-line adjustment. */
  steer?: string;
  /** Injected by tests; production resolves the adapter from the environment. */
  adapter?: LlmAdapter;
  env?: Record<string, string | undefined>;
  /** Trace id for *this* run. A regeneration is a new generation, not an edit of one. */
  generationId?: string;
  logger?: Logger;
  trace?: TraceStoreOptions & { enabled?: boolean };
}

export interface RegenerateHooksInput extends RegenerateCommon {
  hookCount?: number;
  /**
   * The hooks already shown and rejected, handed to the model as
   * avoid-context. Empty is legal and means "just try again".
   */
  avoid?: readonly Hook[];
}

export interface RegenerateScriptInput extends RegenerateCommon {
  /**
   * The hooks currently on screen. Required: the script call is conditioned on
   * them, and a script written against no hook is a script written against a
   * different opening than the one the creator is looking at.
   */
  hooks: readonly Hook[];
}

export interface RegenerationResult {
  target: RegenerationTarget;
  /** The new hooks, or `null` when only the script was re-run. */
  hooks: Hook[] | null;
  /** The new script, or `null` when only the hooks were re-run. */
  script: Script | null;
  /** The subset of Layer 1 this run can answer. See `runHookChecks` / `runScriptChecks`. */
  checks: CheckResult[];
  meta: GenerationMeta;
}

/** Fresh hooks for an idea, written away from the ones already rejected. */
export async function regenerateHooks(
  input: RegenerateHooksInput,
): Promise<RegenerationResult> {
  const generationId = input.generationId ?? newGenerationId();
  const log = generationLogger(generationId, input.logger);

  let idea: string;
  let hookCount: number;
  let steer: string | undefined;
  try {
    idea = normalizeIdea(input.idea);
    hookCount = assertHookCount(input.hookCount ?? DEFAULT_HOOK_COUNT);
    steer = normalizeSteer(input.steer);
  } catch (error) {
    log.warn(
      { event: "regeneration.rejected", target: "hooks", err: errorFields(error) },
      "regeneration rejected before any model call",
    );
    throw error;
  }

  const adapter = input.adapter ?? getAdapter(input.env);
  const hash = profileHash(input.profile);
  const base = { provider: adapter.provider, model: adapter.model };
  const avoid = input.avoid ?? [];

  log.info(
    {
      event: "regeneration.received",
      ...base,
      target: "hooks",
      parent_generation_id: input.parentGenerationId,
      hook_count: hookCount,
      avoided_hooks: avoid.length,
      steered: steer !== undefined,
      profile_hash: hash,
    },
    "hooks regeneration received",
  );

  const startedAt = Date.now();
  const hooksResult = await callPhase(log, base, "hooks", () =>
    adapter.generateStructured(
      buildHooksRequest({ idea, profile: input.profile, hookCount, avoid, steer }),
    ),
  );
  const latencyMs = Date.now() - startedAt;
  const hooks: Hook[] = hooksResult.data.hooks;

  const checks = runHookChecks({
    idea,
    hooks,
    hookCount,
    bannedPhrases: input.profile.traits.banned_phrases,
  });
  logChecks(log, checks);

  return finishRegeneration({
    log,
    input,
    target: "hooks",
    generationId,
    idea,
    hookCount,
    profileHash: hash,
    steer,
    hooks,
    script: null,
    checks,
    result: hooksResult,
    latencyMs,
    timings: { total_ms: latencyMs, hooks_ms: hooksResult.latencyMs, script_ms: 0 },
  });
}

/** A fresh script for the same idea and the same hooks. */
export async function regenerateScript(
  input: RegenerateScriptInput,
): Promise<RegenerationResult> {
  const generationId = input.generationId ?? newGenerationId();
  const log = generationLogger(generationId, input.logger);

  let idea: string;
  let steer: string | undefined;
  try {
    idea = normalizeIdea(input.idea);
    steer = normalizeSteer(input.steer);
    if (input.hooks.length === 0) {
      throw new GenerationInputError(
        "A script is written against the hooks it opens with, so regenerating one needs the hooks that are currently on screen.",
      );
    }
  } catch (error) {
    log.warn(
      { event: "regeneration.rejected", target: "script", err: errorFields(error) },
      "regeneration rejected before any model call",
    );
    throw error;
  }

  const adapter = input.adapter ?? getAdapter(input.env);
  const hash = profileHash(input.profile);
  const base = { provider: adapter.provider, model: adapter.model };
  const hooks = [...input.hooks];

  log.info(
    {
      event: "regeneration.received",
      ...base,
      target: "script",
      parent_generation_id: input.parentGenerationId,
      hook_count: hooks.length,
      steered: steer !== undefined,
      profile_hash: hash,
    },
    "script regeneration received",
  );

  const startedAt = Date.now();
  const scriptResult: StructuredResult<Script> = await callPhase(log, base, "script", () =>
    adapter.generateStructured(
      buildScriptRequest({ idea, profile: input.profile, hooks, steer }),
    ),
  );
  const latencyMs = Date.now() - startedAt;

  const checks = runScriptChecks({
    idea,
    hooks,
    script: scriptResult.data,
    bannedPhrases: input.profile.traits.banned_phrases,
  });
  logChecks(log, checks);

  return finishRegeneration({
    log,
    input,
    target: "script",
    generationId,
    idea,
    hookCount: hooks.length,
    profileHash: hash,
    steer,
    hooks,
    script: scriptResult.data,
    checks,
    result: scriptResult,
    latencyMs,
    timings: { total_ms: latencyMs, hooks_ms: 0, script_ms: scriptResult.latencyMs },
  });
}

/**
 * The half both regenerations share: build the meta, write the trace, log the
 * completion line.
 *
 * Split out rather than duplicated because the trace record is the artefact
 * that cannot be repaired after the fact — two copies of this would be two
 * chances for a regeneration to land in the file missing its parent id.
 */
function finishRegeneration(args: {
  log: Logger;
  input: RegenerateCommon;
  target: RegenerationTarget;
  generationId: string;
  idea: string;
  hookCount: number;
  profileHash: string;
  steer: string | undefined;
  hooks: Hook[];
  script: Script | null;
  checks: CheckResult[];
  result: StructuredResult<unknown>;
  latencyMs: number;
  timings: { total_ms: number; hooks_ms: number; script_ms: number };
}): RegenerationResult {
  const { log, input, target, result } = args;

  const meta: GenerationMeta = {
    generationId: args.generationId,
    model: result.model,
    provider: result.provider,
    cacheReadTokens: result.usage.cacheReadInputTokens,
    latencyMs: args.latencyMs,
    ...(input.parentGenerationId === undefined
      ? {}
      : { parentGenerationId: input.parentGenerationId }),
    regeneratedTarget: target,
  };

  recordTrace(log, input, {
    type: "generation",
    generation_id: args.generationId,
    recorded_at: new Date().toISOString(),
    idea: args.idea,
    hook_count: args.hookCount,
    profile_hash: args.profileHash,
    provider: result.provider,
    model: result.model,
    // The unchanged half is recorded too. A record holding only the new script
    // could not be checked for banned phrases or groundedness later without
    // going back to the parent for the hooks that were on screen beside it.
    hooks: args.hooks,
    script: args.script,
    ...(input.parentGenerationId === undefined
      ? {}
      : { parent_generation_id: input.parentGenerationId }),
    regenerated_target: target,
    ...(args.steer === undefined ? {} : { steer: args.steer }),
    checks: args.checks.map((check) => ({
      name: check.name,
      passed: check.passed,
      score: check.score,
      details: check.details,
    })),
    timings: args.timings,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_read_input_tokens: result.usage.cacheReadInputTokens,
      cache_creation_input_tokens: result.usage.cacheCreationInputTokens,
    },
  });

  log.info(
    {
      event: "regeneration.completed",
      provider: result.provider,
      model: result.model,
      target,
      parent_generation_id: input.parentGenerationId,
      latency_ms: args.latencyMs,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_read_input_tokens: result.usage.cacheReadInputTokens,
      checks_failed: args.checks.filter((check) => !check.passed).length,
    },
    `${target} regeneration completed`,
  );

  return {
    target,
    hooks: target === "hooks" ? args.hooks : null,
    script: args.script,
    checks: args.checks,
    meta,
  };
}
