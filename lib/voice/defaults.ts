import { normalizeBannedPhrases } from "./banned.ts";

/**
 * The banned-phrase list every creator starts from.
 *
 * These are AI tells, not personal preferences: phrases that appear in generic
 * model output far more often than in anyone's actual writing. Seeding them
 * means the banned-phrase check has something to measure on day one, before the
 * creator has thought to add anything of their own — and it makes the editor's
 * purpose legible the moment the page loads rather than presenting an empty box.
 *
 * Distillation may add creator-specific ones on top; `mergeBannedPhrases`
 * below is what keeps the two lists from duplicating each other.
 *
 * Imported by client components, so this module must stay free of `node:` and
 * SDK imports — `./banned.ts` is pure string handling.
 */
export const SEED_BANNED_PHRASES: readonly string[] = [
  "unlock the power of",
  "in today's fast-paced world",
  "dive into",
  "game changer",
  "let's dive in",
  "elevate your",
  "take it to the next level",
  "the ultimate guide",
];

/**
 * Union of two phrase lists, de-duplicated the way the matcher compares them —
 * case-folded and punctuation-insensitive — so "Dive into" and "dive into!"
 * cannot both survive into the profile.
 */
export function mergeBannedPhrases(
  existing: readonly string[],
  additions: readonly string[],
): string[] {
  return normalizeBannedPhrases([...existing, ...additions]);
}
