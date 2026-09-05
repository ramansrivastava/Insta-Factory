/**
 * Typed errors for the LLM layer.
 *
 * Callers (API routes, the CLI, the eval harness) branch on these rather than
 * on provider-specific SDK exceptions, so a provider swap does not ripple out
 * into error handling.
 *
 * Note: no TypeScript parameter properties anywhere in this file. Every module
 * under `lib/` is loaded directly by Node's type stripping in
 * `scripts/eval/run.mjs`, which only accepts erasable syntax. `tsconfig.json`
 * sets `erasableSyntaxOnly` so a violation fails the type check rather than the
 * eval.
 */

export class LlmError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
  }
}

/**
 * The model declined the request (`stop_reason: "refusal"`). This is an HTTP
 * 200, not an exception — the adapter converts it into one so no caller can
 * accidentally read refused content as an answer.
 */
export class LlmRefusalError extends LlmError {
  readonly category: string | null;
  readonly explanation: string | null;

  constructor(
    message: string,
    category: string | null = null,
    explanation: string | null = null,
  ) {
    super(message);
    this.category = category;
    this.explanation = explanation;
  }
}

/** The response did not validate against the requested schema. */
export class LlmSchemaError extends LlmError {}

/** The response was cut off by `max_tokens`, so the structured payload is truncated. */
export class LlmTruncatedError extends LlmError {}

/** Upstream rate limit. `retryAfterSeconds` is surfaced when the provider sends it. */
export class LlmRateLimitError extends LlmError {
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    retryAfterSeconds: number | null = null,
    cause?: unknown,
  ) {
    super(message, cause);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Any other upstream failure: bad request, 5xx, connection error. */
export class LlmUpstreamError extends LlmError {
  readonly status: number | null;

  constructor(message: string, status: number | null = null, cause?: unknown) {
    super(message, cause);
    this.status = status;
  }
}

/** The adapter is misconfigured (unknown provider, missing fixture, ...). */
export class LlmConfigError extends LlmError {}
