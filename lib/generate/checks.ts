import { findBannedPhrases, normalizePhrase } from "../voice/banned.ts";
import {
  REQUIRED_SECTION_KINDS,
  type Hook,
  type Script,
  type SectionKind,
} from "../../types/generation.ts";

/**
 * Layer 1 of the eval: fast, deterministic, zero-network checks over a
 * generation result.
 *
 * These are gates, not scores. Each answers a question with a yes or a no and
 * says exactly what failed — no judgement, no model call, no flakiness. The
 * subjective half of quality (does this actually sound like her?) is Layer 2's
 * problem, and the only real ground truth is Layer 3's accept/edit/discard
 * data. Nothing here pretends to measure whether a hook is *good*.
 */

export interface CheckResult {
  name: string;
  passed: boolean;
  /** 1 or 0 — these are gates. Kept explicit so the eval can weight them. */
  score: number;
  details: string;
}

function pass(name: string, details: string): CheckResult {
  return { name, passed: true, score: 1, details };
}

function fail(name: string, details: string): CheckResult {
  return { name, passed: false, score: 0, details };
}

/** Exactly the number of hooks that were asked for. */
export function checkHookCount(hooks: readonly Hook[], expected: number): CheckResult {
  return hooks.length === expected
    ? pass("hook_count", `${hooks.length} hooks, as requested`)
    : fail("hook_count", `expected ${expected} hooks, got ${hooks.length}`);
}

/**
 * Every hook takes a different angle.
 *
 * This is the whole variety mechanism — with `temperature` unavailable on
 * current models, structurally distinct angles are what stops five hooks from
 * being one hook reworded five ways.
 */
export function checkHookDistinctiveness(hooks: readonly Hook[]): CheckResult {
  const angles = hooks.map((hook) => hook.angle);
  const seen = new Set(angles);

  if (seen.size === angles.length) {
    return pass("hook_distinctiveness", `${seen.size} distinct angles: ${angles.join(", ")}`);
  }

  const duplicated = [...new Set(angles.filter((angle, i) => angles.indexOf(angle) !== i))];
  return fail(
    "hook_distinctiveness",
    `${angles.length} hooks share only ${seen.size} angles — repeated: ${duplicated.join(", ")}`,
  );
}

/** Every piece of generated prose, labelled by where it came from. */
export function collectGeneratedText(
  hooks: readonly Hook[],
  script: Script | null,
): { label: string; text: string; spoken: boolean }[] {
  const pieces: { label: string; text: string; spoken: boolean }[] = [];

  hooks.forEach((hook, index) => {
    pieces.push({ label: `hook ${index + 1} (${hook.angle})`, text: hook.text, spoken: true });
  });

  script?.sections.forEach((section, index) => {
    pieces.push({ label: `section ${index + 1} (${section.kind})`, text: section.text, spoken: true });
    if (section.on_screen_text) {
      pieces.push({
        label: `section ${index + 1} (${section.kind}) on-screen text`,
        text: section.on_screen_text,
        // On-screen text is often Title Case or ALL CAPS by convention, so the
        // capitalised-entity heuristic below would fire on it constantly.
        spoken: false,
      });
    }
  });

  return pieces;
}

/** No phrase from the creator's banned list appears anywhere in the output. */
export function checkBannedPhrases(
  hooks: readonly Hook[],
  script: Script | null,
  bannedPhrases: readonly string[],
): CheckResult {
  if (bannedPhrases.length === 0) {
    return pass("banned_phrases", "profile lists no banned phrases — nothing to check");
  }

  const hits: string[] = [];
  for (const piece of collectGeneratedText(hooks, script)) {
    for (const phrase of findBannedPhrases(piece.text, bannedPhrases)) {
      hits.push(`"${phrase}" in ${piece.label}`);
    }
  }

  return hits.length === 0
    ? pass("banned_phrases", `none of the ${bannedPhrases.length} banned phrases appear`)
    : fail("banned_phrases", `banned phrases used: ${hits.join("; ")}`);
}

/** The script has the sections a Reel is unusable without. */
export function checkSectionCompleteness(script: Script): CheckResult {
  const present = new Set<SectionKind>(
    script.sections.filter((section) => section.text.trim()).map((section) => section.kind),
  );
  const missing = REQUIRED_SECTION_KINDS.filter((kind) => !present.has(kind));

  return missing.length === 0
    ? pass(
        "section_completeness",
        `${script.sections.length} sections; required kinds present: ${REQUIRED_SECTION_KINDS.join(", ")}`,
      )
    : fail("section_completeness", `missing required section(s): ${missing.join(", ")}`);
}

/*
 * Groundedness.
 *
 * The check is deliberately a lint, not a fact-checker: it flags the three
 * shapes fabrication actually takes in this product — a number, a currency or
 * percentage figure, and a multi-word capitalised name — when they appear in
 * the script but not in the creator's idea. It cannot catch an invented claim
 * written in plain lowercase prose, and it is not meant to. What it does catch
 * is the failure that destroys trust: a script that quotes "73% of lifters" or
 * cites "the Stanford Sleep Lab" that the creator never mentioned.
 */

/** Digits, optionally with a currency mark, separators or a percent sign. */
const NUMERIC = /[$£€]?\d[\d.,]*\s?%?/g;

/**
 * Multi-word capitalised runs. `\p{Lu}` rather than `A-Z` so accented names
 * count.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu;

/** Capitalised words that start sentences constantly and name nothing. */
const NOT_A_NAME = new Set(["I", "I'm", "I've", "I'll", "OK", "TL;DR"]);

function isCapitalised(word: string): boolean {
  const first = word[0];
  if (!first) return false;
  // Single letters ("I", "A") are never half of a real entity worth flagging.
  if (word.length < 2) return false;
  if (NOT_A_NAME.has(word)) return false;
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

/** Normalised numbers appearing in `text` — "$1,200" and "1200" compare equal. */
export function extractNumbers(text: string): string[] {
  const found = text.match(NUMERIC) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of found) {
    const token = raw.trim();
    const key = normalizeNumber(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }

  return out;
}

/** Comparison key: digits only, so punctuation and spacing cannot hide a match. */
function normalizeNumber(token: string): string {
  return token.replace(/[^\d]/g, "");
}

/**
 * Runs of two or more consecutive capitalised words.
 *
 * The word that opens a sentence is skipped, because it is capitalised by
 * grammar rather than by being a name — without that, "Take twenty kilos off"
 * would read as an entity. The cost is that a name at the very start of a
 * sentence is missed; that is the right trade for a check that gates a build.
 */
export function extractCapitalisedEntities(text: string): string[] {
  const entities: string[] = [];
  const seen = new Set<string>();

  for (const sentence of text.split(/(?<=[.!?:;\n])\s+|\n+/)) {
    const words = sentence.match(WORD) ?? [];
    // Drop the sentence-initial word: its capitalisation carries no signal.
    const candidates = words.slice(1);

    let run: string[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const entity = run.join(" ");
        const key = normalizePhrase(entity);
        if (key && !seen.has(key)) {
          seen.add(key);
          entities.push(entity);
        }
      }
      run = [];
    };

    for (const word of candidates) {
      if (isCapitalised(word)) {
        run.push(word);
      } else {
        flush();
      }
    }
    flush();
  }

  return entities;
}

/** True when `span` appears in `idea`, ignoring case and punctuation. */
export function ideaContains(idea: string, span: string): boolean {
  const needle = normalizePhrase(span);
  if (!needle) return false;
  return normalizePhrase(idea).includes(needle);
}

export interface GroundednessViolation {
  kind: "number" | "entity" | "unquoted_claim";
  value: string;
  where: string;
}

/**
 * Every number, name and claim in the script traces back to the creator's idea.
 *
 * Three separate failures, one dimension:
 *   - a number in the script that is not in the idea
 *   - a multi-word capitalised name in the spoken script that is not in the idea
 *   - a `claims[].grounded_in` that does not actually quote the idea (the model
 *     attributing to a span it invented is the same failure one level up)
 */
export function findGroundednessViolations(
  hooks: readonly Hook[],
  script: Script | null,
  idea: string,
): GroundednessViolation[] {
  const violations: GroundednessViolation[] = [];
  const ideaNumbers = new Set(extractNumbers(idea).map(normalizeNumber));

  for (const piece of collectGeneratedText(hooks, script)) {
    for (const number of extractNumbers(piece.text)) {
      if (!ideaNumbers.has(normalizeNumber(number))) {
        violations.push({ kind: "number", value: number, where: piece.label });
      }
    }

    if (!piece.spoken) continue;

    for (const entity of extractCapitalisedEntities(piece.text)) {
      if (!ideaContains(idea, entity)) {
        violations.push({ kind: "entity", value: entity, where: piece.label });
      }
    }
  }

  script?.claims.forEach((claim, index) => {
    if (!ideaContains(idea, claim.grounded_in)) {
      violations.push({
        kind: "unquoted_claim",
        value: `"${claim.grounded_in}"`,
        where: `claim ${index + 1}`,
      });
    }
  });

  return violations;
}

export function checkGroundedness(
  hooks: readonly Hook[],
  script: Script | null,
  idea: string,
): CheckResult {
  const violations = findGroundednessViolations(hooks, script, idea);

  if (violations.length === 0) {
    return pass(
      "groundedness",
      script === null
        ? `no unsupported numbers or names across ${hooks.length} hooks`
        : `no unsupported numbers, names or claims across ${script.sections.length} sections and ${script.claims.length} claims`,
    );
  }

  const rendered = violations
    .map((violation) => `${violation.kind} ${violation.value} in ${violation.where}`)
    .join("; ");
  return fail("groundedness", `not grounded in the idea: ${rendered}`);
}

/**
 * The subset of checks a hooks-only regeneration can answer.
 *
 * Section completeness is absent because there is no script in this run to be
 * complete — reporting it as failed would be reporting a script that was never
 * asked for. The remaining four are exactly as strict as they are in a full
 * generation; a regenerated hook set is not held to a lower bar than a
 * first-round one.
 */
export interface HooksCheckInput {
  idea: string;
  hooks: readonly Hook[];
  hookCount: number;
  bannedPhrases: readonly string[];
}

export function runHookChecks(input: HooksCheckInput): CheckResult[] {
  return [
    checkHookCount(input.hooks, input.hookCount),
    checkHookDistinctiveness(input.hooks),
    checkBannedPhrases(input.hooks, null, input.bannedPhrases),
    checkGroundedness(input.hooks, null, input.idea),
  ];
}

/**
 * The subset a script-only regeneration can answer.
 *
 * The hooks are still passed in — they are unchanged and still on screen, and a
 * banned phrase or an invented number in them is still in the creator's output
 * whether or not this run produced them.
 */
export interface ScriptCheckInput {
  idea: string;
  hooks: readonly Hook[];
  script: Script;
  bannedPhrases: readonly string[];
}

export function runScriptChecks(input: ScriptCheckInput): CheckResult[] {
  return [
    checkBannedPhrases(input.hooks, input.script, input.bannedPhrases),
    checkSectionCompleteness(input.script),
    checkGroundedness(input.hooks, input.script, input.idea),
  ];
}

export interface Layer1Input {
  idea: string;
  hooks: readonly Hook[];
  script: Script;
  hookCount: number;
  bannedPhrases: readonly string[];
}

/** All five deterministic dimensions, in a stable order. */
export function runLayer1Checks(input: Layer1Input): CheckResult[] {
  return [
    checkHookCount(input.hooks, input.hookCount),
    checkHookDistinctiveness(input.hooks),
    checkBannedPhrases(input.hooks, input.script, input.bannedPhrases),
    checkSectionCompleteness(input.script),
    checkGroundedness(input.hooks, input.script, input.idea),
  ];
}
