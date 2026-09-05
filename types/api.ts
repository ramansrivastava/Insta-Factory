import { z } from "zod";

import { MAX_IDEA_LENGTH, MIN_IDEA_LENGTH } from "../lib/generate/idea.ts";
import {
  DEFAULT_HOOK_COUNT,
  MAX_HOOKS,
  MIN_HOOKS,
  type GenerationMeta,
  type Hook,
  type Script,
} from "./generation.ts";

/**
 * The wire contract for `POST /api/generate`, shared by the route handler and
 * the browser.
 *
 * This module imports nothing that touches the filesystem or the Anthropic SDK,
 * which is what lets the client component import it. Keep it that way: the
 * moment this file reaches into `lib/llm/` the whole adapter tree lands in the
 * browser bundle.
 */

export const GenerateRequestSchema = z.strictObject({
  /** The creator's raw idea, in their own words. */
  idea: z
    .string()
    .trim()
    .min(
      MIN_IDEA_LENGTH,
      `An idea needs at least ${MIN_IDEA_LENGTH} characters — the generator adds structure to what you write, it does not invent the substance.`,
    )
    .max(
      MAX_IDEA_LENGTH,
      `An idea can be at most ${MAX_IDEA_LENGTH} characters. Paste the gist, not the finished script.`,
    ),
  /**
   * Capped at the number of hook angles, not at some round number: every hook
   * must take a different angle, so asking for more hooks than there are angles
   * is not a big request, it is an impossible one.
   */
  hookCount: z
    .number()
    .int(`hookCount must be a whole number between ${MIN_HOOKS} and ${MAX_HOOKS}.`)
    .min(MIN_HOOKS, `Ask for at least ${MIN_HOOKS} hooks — fewer is not a choice.`)
    .max(
      MAX_HOOKS,
      `At most ${MAX_HOOKS} hooks: each one takes a different angle and there are only ${MAX_HOOKS} angles.`,
    )
    .default(DEFAULT_HOOK_COUNT),
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

/**
 * Why the request did not produce a script. The UI branches on this rather
 * than on the status code, so a new failure mode can be given its own wording
 * without the client re-deriving meaning from a number.
 */
export const GENERATE_ERROR_CODES = [
  /** 400 — the request itself is wrong. Fixable by the creator. */
  "bad_request",
  /** 422 — the model declined to answer. */
  "refused",
  /** 422 — the model answered, but never in the required shape. Retry may help. */
  "invalid_output",
  /** 429 — upstream rate limit. `retryAfterSeconds` says when to try again. */
  "rate_limited",
  /** 502 — the provider failed or returned something unusable. */
  "upstream",
  /** 500 — this app is misconfigured or broke. Not the creator's problem. */
  "server_error",
] as const;

export type GenerateErrorCode = (typeof GENERATE_ERROR_CODES)[number];

export interface GenerateSuccessBody {
  ok: true;
  /** Echoed back normalised. The UI checks claims against *this*, not the textarea. */
  idea: string;
  hookCount: number;
  hooks: Hook[];
  script: Script;
  meta: GenerationMeta & {
    /**
     * True when no `data/voice-profile.json` exists and the committed example
     * profile was used. The output is then in a stranger's voice, which is
     * worth saying out loud rather than letting the creator wonder.
     */
    usedExampleProfile: boolean;
    /** Advisory notes about the profile (thin sample set, and so on). */
    profileWarnings: string[];
  };
}

export interface GenerateErrorBody {
  ok: false;
  error: {
    code: GenerateErrorCode;
    /** Written for the creator to read, not for a log. */
    message: string;
    /** Field-level detail for `bad_request`. */
    details?: string[];
    /** Present on `rate_limited` when the provider told us how long to wait. */
    retryAfterSeconds?: number;
  };
}

export type GenerateResponseBody = GenerateSuccessBody | GenerateErrorBody;

/** Hook counts the UI offers. Derived, so the selector can never offer an impossible one. */
export const HOOK_COUNT_OPTIONS: number[] = Array.from(
  { length: MAX_HOOKS - MIN_HOOKS + 1 },
  (_, index) => MIN_HOOKS + index,
);
