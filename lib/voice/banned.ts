/**
 * Banned-phrase matching.
 *
 * A creator writes "Let's dive in!" in their banned list and the model emits
 * "let's dive in" or "Let's dive in..." — the same phrase as far as anyone
 * cares. Matching therefore happens on a normalised form: case-folded, with
 * punctuation flattened to spaces and whitespace collapsed.
 *
 * Comparison is token-boundary aware (both sides are padded with spaces before
 * the containment check), so a short banned phrase like "ai" does not fire on
 * "said" or "chair".
 */

const NON_WORD = /[^\p{L}\p{N}]+/gu;
/** Apostrophes are deleted rather than spaced, so "let's" and "lets" agree. */
const APOSTROPHE = /['\u2018\u2019\u02bc`\u00b4]/g;

/** Case-folded, punctuation-insensitive, whitespace-collapsed form. */
export function normalizePhrase(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(APOSTROPHE, "")
    .replace(NON_WORD, " ")
    .trim();
}

/** Drops empties and duplicates that differ only by case or punctuation. */
export function normalizeBannedPhrases(phrases: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const phrase of phrases) {
    const normalized = normalizePhrase(phrase);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    kept.push(phrase.trim());
  }

  return kept;
}

/** True when `text` contains `phrase`, ignoring case and punctuation. */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = normalizePhrase(phrase);
  if (!needle) return false;
  return ` ${normalizePhrase(text)} `.includes(` ${needle} `);
}

/**
 * The banned phrases that actually appear in `text`, returned in their original
 * spelling so an error message can quote the creator's own list back to them.
 */
export function findBannedPhrases(
  text: string,
  bannedPhrases: readonly string[],
): string[] {
  const haystack = ` ${normalizePhrase(text)} `;
  const hits: string[] = [];
  const seen = new Set<string>();

  for (const phrase of bannedPhrases) {
    const needle = normalizePhrase(phrase);
    if (!needle || seen.has(needle)) continue;
    if (haystack.includes(` ${needle} `)) {
      seen.add(needle);
      hits.push(phrase.trim());
    }
  }

  return hits;
}
