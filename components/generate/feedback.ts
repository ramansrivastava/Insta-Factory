import {
  MAX_EDITED_TEXT_LENGTH,
  type FeedbackOutcome,
  type FeedbackRequest,
  type FeedbackTarget,
} from "@/types/feedback.ts";

/**
 * The rules behind the feedback buttons, kept out of the component so they can
 * be unit tested without a renderer — same split as `./script-text.ts`.
 */

export interface FeedbackSubject {
  generationId: string;
  target: FeedbackTarget;
  /** Zero-based. Present for a hook, absent for the script. */
  hookIndex?: number;
}

/**
 * Builds the request body.
 *
 * The rewrite is attached only to `edited`. Typing a revision and then pressing
 * "Discarded" means the revision was abandoned too, and shipping it under a
 * discard would poison the one field that is supposed to mean "here is what
 * she actually said instead".
 */
export function buildFeedbackPayload(
  subject: FeedbackSubject,
  outcome: FeedbackOutcome,
  editedText: string,
): FeedbackRequest {
  const trimmed = editedText.trim();
  return {
    generationId: subject.generationId,
    target: subject.target,
    ...(subject.hookIndex === undefined ? {} : { hookIndex: subject.hookIndex }),
    outcome,
    ...(outcome === "edited" && trimmed ? { editedText: trimmed } : {}),
  };
}

/** True when the rewrite is longer than the API will accept. */
export function isEditTooLong(editedText: string): boolean {
  return editedText.trim().length > MAX_EDITED_TEXT_LENGTH;
}

/**
 * What to say once a choice has landed. Three outcomes get three different
 * confirmations rather than one "Thanks!", because the creator should be able
 * to tell at a glance which of five hooks they already rated.
 */
export function confirmationFor(outcome: FeedbackOutcome): string {
  switch (outcome) {
    case "used_as_is":
      return "Noted — used as-is.";
    case "edited":
      return "Noted — your version is saved.";
    case "discarded":
      return "Noted — discarded.";
  }
}
