/**
 * The canonical idea used by `npm run generate` with no arguments and by the
 * Layer-1 eval.
 *
 * The mock adapter answers from a fixture rather than from the prompt, so the
 * groundedness dimension is only meaningful when the idea and the fixture line
 * up. Both sides read this constant, and `fixtures/llm/script.json` is written
 * to be grounded in exactly these words — change one and the eval will tell you
 * about the other.
 *
 * Every quantity here is spelled out rather than written in digits, so the
 * fixture can talk about the idea's own numbers without tripping the check.
 */
export const SAMPLE_IDEA =
  "Most people quit lifting because they build a program for the version of themselves with six free hours a week. I want to make a reel about why two sessions a week beats a five-day split you abandon by week three, and how I actually run my two sessions.";
