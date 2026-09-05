import { z } from "zod";

import { MAX_HOOKS } from "./generation.ts";

/**
 * The wire contract for `POST /api/feedback` — Layer 3 of the eval strategy.
 *
 * Three outcomes and one optional field, and that is the whole vocabulary. The
 * research finding this implements is specific: feedback capture only survives
 * contact with a working creator if it is structured and near-zero friction. An
 * open-ended "how did we do?" box returns nothing usable and, worse, returns it
 * rarely — whereas *used it / rewrote it / binned it* is one click on the way
 * to recording, and it is the only ground truth this product will ever have for
 * whether a hook was actually good. Audience response is unobservable at
 * generation time; what the creator did with the words is not.
 *
 * This module imports nothing that touches the filesystem, so the browser can
 * import it. Keep it that way.
 */

export const FEEDBACK_OUTCOMES = [
  /** Copied and used unchanged. The strongest positive signal available. */
  "used_as_is",
  /** Kept, but rewritten. `editedText` holds the creator's version. */
  "edited",
  /** Thrown away. */
  "discarded",
] as const;

export const FeedbackOutcomeSchema = z.enum(FEEDBACK_OUTCOMES);
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export const FEEDBACK_OUTCOME_LABELS: Record<FeedbackOutcome, string> = {
  used_as_is: "Used as-is",
  edited: "Edited",
  discarded: "Discarded",
};

/** What the creator is judging: one hook, or the script as a whole. */
export const FeedbackTargetSchema = z.enum(["hook", "script"]);
export type FeedbackTarget = z.infer<typeof FeedbackTargetSchema>;

/** An edit longer than this is a new script, not a revision of ours. */
export const MAX_EDITED_TEXT_LENGTH = 4000;

export const FeedbackRequestSchema = z
  .strictObject({
    /**
     * The trace id from `meta.generationId`. Without it a rating is an opinion
     * about nothing — it cannot be joined back to the idea, the profile or the
     * prompt that produced the words being rated.
     */
    generationId: z.string().trim().min(1, "generationId is required."),
    target: FeedbackTargetSchema,
    /** Which hook, zero-based. Required for `target: "hook"`, absent otherwise. */
    hookIndex: z.number().int().min(0).max(MAX_HOOKS - 1).optional(),
    outcome: FeedbackOutcomeSchema,
    /** The creator's rewrite. Only meaningful on `edited`, and never required. */
    editedText: z
      .string()
      .trim()
      .max(
        MAX_EDITED_TEXT_LENGTH,
        `An edit can be at most ${MAX_EDITED_TEXT_LENGTH} characters.`,
      )
      .optional(),
  })
  .refine((body) => (body.target === "hook") === (body.hookIndex !== undefined), {
    message: "hookIndex is required for a hook and must be omitted for the script.",
    path: ["hookIndex"],
  });

export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

export interface FeedbackSuccessBody {
  ok: true;
  /** Echoed back so the client can confirm it landed against the right trace. */
  generationId: string;
  recordedAt: string;
}
