/**
 * The raw idea: its bounds, its normalisation, and the error raised when it is
 * unusable.
 *
 * This lives apart from `pipeline.ts` for one concrete reason: the browser
 * needs these bounds too. The generation form wants to tell the creator "an
 * idea needs at least N characters" *before* a round trip, and importing
 * `pipeline.ts` to learn that would drag `lib/llm/` — and with it the Anthropic
 * SDK — into the client bundle. This module stays free of anything that
 * touches the filesystem or a provider SDK, so both sides can read the same
 * numbers instead of keeping two copies in sync by hand.
 *
 * `pipeline.ts` re-exports everything here, so existing callers are unaffected.
 *
 * The single import below is `MAX_STEER_LENGTH`, a constant out of
 * `types/generation.ts`, which pulls in nothing heavier than Zod. Keep it that
 * way — anything reaching into `lib/llm/` from here undoes the split.
 */

import { MAX_STEER_LENGTH } from "../../types/generation.ts";

/**
 * Below this the generator has nothing to elaborate on. It adds structure,
 * pacing and voice to what the creator supplies — it does not invent the
 * substance, and a three-word "idea" forces it to.
 */
export const MIN_IDEA_LENGTH = 12;

/**
 * Upper bound for the HTTP surface only. `normalizeIdea` deliberately does not
 * enforce it: the CLI and the eval hand the pipeline text from files the
 * operator controls, whereas the API accepts a request body from the network
 * and needs a ceiling on what one request can turn into tokens.
 */
export const MAX_IDEA_LENGTH = 4000;

export class GenerationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationInputError";
  }
}

export function normalizeIdea(idea: string): string {
  const trimmed = (idea ?? "").trim();
  if (trimmed.length < MIN_IDEA_LENGTH) {
    throw new GenerationInputError(
      `An idea needs at least ${MIN_IDEA_LENGTH} characters to elaborate on; got ${trimmed.length}. The generator adds structure to what you supply — it does not invent the substance.`,
    );
  }
  return trimmed;
}

/**
 * The optional one-line steer that rides along with a regeneration.
 *
 * Absent and blank are the same answer — "no steer" — and both give back
 * `undefined` rather than an empty string, so a caller can spread the result
 * without deciding what `""` means. Only an over-long steer is an error, and it
 * is an error rather than a silent truncation because the creator should find
 * out that half their sentence was dropped before the model does.
 */
export function normalizeSteer(steer: string | undefined | null): string | undefined {
  const trimmed = (steer ?? "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_STEER_LENGTH) {
    throw new GenerationInputError(
      `A steer is one line — at most ${MAX_STEER_LENGTH} characters; got ${trimmed.length}. Say the one thing to change ("more casual", "lead with the mistake"); anything longer belongs in the idea itself.`,
    );
  }
  return trimmed;
}
