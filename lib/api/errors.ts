import { FeedbackWriteError } from "./feedback-service.ts";
import { HookRequestError } from "../prompts/hooks.ts";
import { GenerationInputError } from "../generate/idea.ts";
import {
  LlmConfigError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmSchemaError,
  LlmTruncatedError,
  LlmUpstreamError,
} from "../llm/errors.ts";
import { VoiceDistillError } from "../voice/distill.ts";
import { VoiceProfileError } from "../voice/store.ts";
import type { GenerateErrorBody, GenerateErrorCode } from "../../types/api.ts";

/**
 * Translates a thrown error into an HTTP answer.
 *
 * The whole point of the typed errors in `lib/llm/errors.ts` is that "the model
 * refused", "the model produced garbage twice", "we are rate limited" and "the
 * provider is down" are four different situations for the person waiting on a
 * script — one wants rewording, one wants a retry, one wants a wait, one wants
 * patience. Collapsing them into a single 500 with "something went wrong" is
 * exactly the failure this function exists to prevent.
 *
 * It lives outside the route handler because Next.js route modules may only
 * export route handlers and segment config, so this is where it can be unit
 * tested directly.
 */

export interface ApiErrorResponse {
  status: number;
  body: GenerateErrorBody;
  headers: Record<string, string>;
}

function error(
  status: number,
  code: GenerateErrorCode,
  message: string,
  extra: { details?: string[]; retryAfterSeconds?: number } = {},
  headers: Record<string, string> = {},
): ApiErrorResponse {
  return {
    status,
    body: {
      ok: false,
      error: {
        code,
        message,
        ...(extra.details ? { details: extra.details } : {}),
        ...(extra.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: extra.retryAfterSeconds }
          : {}),
      },
    },
    headers,
  };
}

/** 400 for a request the caller can fix by changing what they sent. */
export function badRequest(message: string, details?: string[]): ApiErrorResponse {
  return error(400, "bad_request", message, details ? { details } : {});
}

export function toApiError(thrown: unknown): ApiErrorResponse {
  // The idea was too short, or the hook count was out of range — both are the
  // caller's input, caught one layer deeper than the request schema.
  if (thrown instanceof GenerationInputError || thrown instanceof HookRequestError) {
    return badRequest(thrown.message);
  }

  if (thrown instanceof LlmRefusalError) {
    const because = thrown.explanation ? ` ${thrown.explanation}` : "";
    return error(
      422,
      "refused",
      `The model declined to write this one.${because} Try rephrasing the idea.`,
    );
  }

  // Reached only after the bounded retry in the generation service, so this
  // genuinely means "twice in a row" rather than "once, unluckily".
  if (thrown instanceof LlmSchemaError) {
    return error(
      422,
      "invalid_output",
      "The model answered twice without producing a usable hooks-and-script structure. Rephrasing the idea, or asking for fewer hooks, usually clears it.",
    );
  }

  // Distillation ran but produced traits the profile schema rejects. Same class
  // of failure as `LlmSchemaError` from the caller's side — the model answered,
  // the answer was not usable — so it gets the same code and a re-ask hint.
  if (thrown instanceof VoiceDistillError) {
    return error(
      422,
      "invalid_output",
      `The model could not distil a usable voice profile from those samples: ${thrown.message}`,
    );
  }

  if (thrown instanceof LlmRateLimitError) {
    const seconds = thrown.retryAfterSeconds;
    const wait =
      seconds === null
        ? "Wait a moment and try again."
        : `Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
    return error(
      429,
      "rate_limited",
      `The model provider is rate limiting this key. ${wait}`,
      seconds === null ? {} : { retryAfterSeconds: seconds },
      // Mirrored into the header the provider gave us so anything speaking HTTP
      // — a proxy, a client library, the browser — can honour it without
      // parsing our body.
      seconds === null ? {} : { "retry-after": String(seconds) },
    );
  }

  // The response hit the token ceiling, so the structured payload is a
  // fragment. That is an upstream shortfall, not a refusal and not bad input.
  if (thrown instanceof LlmTruncatedError) {
    return error(
      502,
      "upstream",
      "The model ran out of room before finishing the script. Try a shorter idea or fewer hooks.",
    );
  }

  if (thrown instanceof LlmUpstreamError) {
    return error(
      502,
      "upstream",
      `The model provider failed to answer${thrown.status ? ` (HTTP ${thrown.status})` : ""}. This is upstream of us — try again shortly.`,
    );
  }

  // Everything below is our fault, not the caller's, so it is a 5xx with a
  // message that points at the fix rather than at the stack.
  if (thrown instanceof LlmConfigError) {
    return error(
      500,
      "server_error",
      `The generator is misconfigured: ${thrown.message}`,
    );
  }

  // The generation succeeded and only the accept/edit/discard line failed to
  // land. Still a 500 — silently dropping the one piece of ground truth this
  // product will ever have would be worse than telling the caller.
  if (thrown instanceof FeedbackWriteError) {
    return error(
      500,
      "server_error",
      `Could not record that feedback: ${thrown.message} Check that data/generations/ is writable.`,
    );
  }

  if (thrown instanceof VoiceProfileError) {
    return error(500, "server_error", `Could not load a voice profile: ${thrown.message}`);
  }

  return error(
    500,
    "server_error",
    "The generator failed unexpectedly. Check the server logs for the cause.",
  );
}
