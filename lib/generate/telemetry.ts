import type { Logger } from "pino";

import type { CheckResult } from "./checks.ts";
import {
  appendTraceRecord,
  tracingEnabled,
  type GenerationRecord,
  type TraceStoreOptions,
} from "../generations/store.ts";
import { callFields, errorFields, type GenerationPhase } from "../log.ts";
import type { StructuredResult } from "../llm/types.ts";

/**
 * The instrumentation a run leaves behind, shared by the full pipeline and by
 * the half-runs in `./regenerate.ts`.
 *
 * These three live apart from both callers on purpose. A regeneration that
 * logged its calls differently from a generation, or wrote its trace through a
 * second copy of the same append-and-swallow-the-error logic, would make the
 * JSONL file two file formats wearing one name — and that file is the only
 * record of what the model was actually asked and what came back.
 */

/**
 * The trace-related slice of a run's input. Both `GenerateInput` and the
 * regeneration inputs satisfy it structurally.
 */
export interface TraceInput {
  env?: Record<string, string | undefined>;
  trace?: TraceStoreOptions & { enabled?: boolean };
}

/** One LLM call, bracketed by an issued line and a returned-or-failed line. */
export async function callPhase<T>(
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
export function logChecks(log: Logger, checks: CheckResult[]): void {
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
export function recordTrace(
  log: Logger,
  input: TraceInput,
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
