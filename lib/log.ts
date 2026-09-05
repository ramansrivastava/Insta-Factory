import pino, { type Logger } from "pino";

import type { LlmUsage, StructuredResult } from "./llm/types.ts";

/**
 * Structured logging for the whole server side.
 *
 * One JSON object per line on stdout, no pretty-printer and no transport. That
 * is deliberate: a transport spawns a worker thread, which is exactly the thing
 * that breaks under Next.js's server bundling and under Node's type-stripping
 * loader that `scripts/` relies on. Plain stdout works identically in `next
 * dev`, `next start`, the CLI and the eval, and anything that wants pretty
 * output can pipe through `pino-pretty` at the shell.
 *
 * Field names are snake_case here even though the rest of the codebase is
 * camelCase. Log lines are read by log tooling and by `grep`, not by
 * TypeScript, and `cache_read_input_tokens` matching the provider's own field
 * name is worth more than internal consistency.
 */

/** Which of the two LLM calls a line is about. */
export type GenerationPhase = "hooks" | "script";

/**
 * Every line in a generation's trace carries this, so one request can be
 * reassembled from an interleaved log with a single `grep`.
 */
export interface GenerationContext {
  generation_id: string;
}

function resolveLevel(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.LOG_LEVEL?.trim();
  if (requested) return requested;
  // Vitest asserts on logger *calls*, not on stdout, so emitting the lines
  // during a test run would only interleave JSON into the test report.
  if (env.VITEST) return "silent";
  return "info";
}

export const logger: Logger = pino({
  level: resolveLevel(),
  base: { service: "instagram-creator-os" },
  // ISO timestamps rather than epoch millis: these lines are read by a human
  // correlating a complaint ("the 3pm one sounded nothing like me") with a
  // trace, and epoch millis make that a conversion step.
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** A fresh trace id. Minted once at request entry and threaded from there. */
export function newGenerationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * A logger bound to one generation. Every line it emits carries
 * `generation_id`, so nothing downstream has to remember to pass it.
 */
export function generationLogger(generationId: string, base: Logger = logger): Logger {
  return base.child({ generation_id: generationId } satisfies GenerationContext);
}

export interface UsageFields {
  input_tokens: number;
  output_tokens: number;
  /**
   * Zero across repeated generations with an unchanged profile is the canonical
   * signal that something per-request has leaked into the cacheable prefix.
   * Prompt caching fails silently, so this number going flat is the only
   * warning there is.
   */
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export function usageFields(usage: LlmUsage): UsageFields {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
  };
}

export interface CallFields extends UsageFields {
  provider: string;
  model: string;
  phase: GenerationPhase;
  latency_ms: number;
}

/** The fields a "call returned" line carries, from the adapter's own result. */
export function callFields(
  phase: GenerationPhase,
  result: StructuredResult<unknown>,
): CallFields {
  return {
    provider: result.provider,
    model: result.model,
    phase,
    latency_ms: result.latencyMs,
    ...usageFields(result.usage),
  };
}

/**
 * Errors are logged as `{ err: { type, message, stack } }` rather than as a
 * flattened message, so the type that drove the HTTP status code stays visible
 * in the log — "the model refused" and "we are rate limited" are the same
 * sentence to a string formatter and different incidents to a human.
 */
export function errorFields(error: unknown): {
  type: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { type: typeof error, message: String(error) };
}
