import { z } from "zod";

import type { CheckResult } from "../lib/generate/checks.ts";

/**
 * The shapes the core loop produces: N structurally distinct hooks, and a
 * sectioned script that is grounded in the creator's own idea.
 *
 * These schemas are the single source of truth — the prompt builders convert
 * them to JSON Schema for the provider, the pipeline parses responses through
 * them, the deterministic checks read them, and the UI (Phase 4) renders them.
 */

/**
 * Closed set of hook angles.
 *
 * This enum is how hook *variety* is produced. The obvious mechanism —
 * generating hooks at a high `temperature` — is unavailable: `temperature`,
 * `top_p` and `top_k` are removed on Claude Sonnet 5 and Opus 5 and return a
 * 400. Requiring N hooks with N *distinct* angles is a stronger guarantee than
 * sampling noise ever gave, and unlike a temperature it can be checked
 * deterministically after the fact.
 */
export const HOOK_ANGLES = [
  "curiosity_gap",
  "contrarian",
  "bold_claim",
  "stat_or_fact",
  "pain_point",
  "story_cold_open",
] as const;

export const HookAngleSchema = z.enum(HOOK_ANGLES);
export type HookAngle = z.infer<typeof HookAngleSchema>;

/** Human-readable labels, for the CLI and for Phase 4's hook list. */
export const HOOK_ANGLE_LABELS: Record<HookAngle, string> = {
  curiosity_gap: "Curiosity gap",
  contrarian: "Contrarian",
  bold_claim: "Bold claim",
  stat_or_fact: "Stat or fact",
  pain_point: "Pain point",
  story_cold_open: "Story cold open",
};

/** One-line briefs, rendered into the hooks prompt so the enum is self-explaining. */
export const HOOK_ANGLE_BRIEFS: Record<HookAngle, string> = {
  curiosity_gap:
    "open a gap the viewer needs closed — name the thing without explaining it yet",
  contrarian: "contradict what this audience already believes, plainly and without hedging",
  bold_claim: "state the strongest true version of the idea as a flat assertion",
  stat_or_fact:
    "lead with a concrete number or fact THAT THE IDEA ALREADY CONTAINS — never invent one",
  pain_point: "name the frustration the viewer is living in right now, in their words",
  story_cold_open: "drop into the middle of a moment, present tense, no setup",
};

/**
 * Every hook must carry a distinct angle, so the number of hooks can never
 * exceed the number of angles. A UI that offers "7 hooks" is offering an
 * impossible request.
 */
export const MAX_HOOKS = HOOK_ANGLES.length;
export const MIN_HOOKS = 3;
export const DEFAULT_HOOK_COUNT = 5;

export const HookSchema = z.object({
  /** The hook line itself — what gets said in the first two seconds. */
  text: z.string().trim().min(1).max(300),
  angle: HookAngleSchema,
  /** Why this angle works for this idea. One sentence, for the creator to choose by. */
  rationale: z.string().trim().min(1).max(400),
});
export type Hook = z.infer<typeof HookSchema>;

/**
 * The hooks payload for a specific requested count. Built per request rather
 * than being a constant, because "exactly N" is the whole point — a schema with
 * an open-ended array lets the model return four hooks when five were asked
 * for, and then nothing downstream can tell that apart from a good answer.
 */
export function hooksResultSchema(count: number) {
  return z.object({
    hooks: z.array(HookSchema).length(count),
  });
}

export type HooksResult = { hooks: Hook[] };

/** Reel structure, in the order the sections are spoken. */
export const SECTION_KINDS = ["hook", "setup", "body", "payoff", "cta"] as const;
export const SectionKindSchema = z.enum(SECTION_KINDS);
export type SectionKind = z.infer<typeof SectionKindSchema>;

/** The sections a script is incomplete without. */
export const REQUIRED_SECTION_KINDS: readonly SectionKind[] = ["hook", "body", "cta"];

export const SECTION_BRIEFS: Record<SectionKind, string> = {
  hook: "the first line, spoken to camera — earn the next three seconds",
  setup: "one or two lines of context so the payoff lands; no throat-clearing",
  body: "the substance — the actual thing the viewer came for",
  payoff: "the turn: what changes for them now that they know this",
  cta: "one specific ask, in the creator's own register — never a generic 'follow for more'",
};

export const ScriptSectionSchema = z.object({
  kind: SectionKindSchema,
  /** What is said aloud. */
  text: z.string().trim().min(1).max(1500),
  /** Optional burned-in caption for this section. Short enough to read on a phone. */
  on_screen_text: z.string().trim().max(120).optional(),
});
export type ScriptSection = z.infer<typeof ScriptSectionSchema>;

/**
 * A factual assertion the script makes, paired with the span of the creator's
 * idea it comes from.
 *
 * `grounded_in` is a required field on purpose. A script generator asked to pad
 * a one-line idea into a full Reel will invent plausible statistics — that is a
 * trust failure, not a polish failure. Forcing the model to *attribute* every
 * claim to a quoted span of the input makes fabrication both harder to do and
 * (see `lib/generate/checks.ts`) deterministically detectable when it happens.
 */
export const ClaimSchema = z.object({
  text: z.string().trim().min(1).max(400),
  /** A verbatim span of the creator's idea. Checked, not trusted. */
  grounded_in: z.string().trim().min(1).max(400),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ScriptSchema = z.object({
  sections: z.array(ScriptSectionSchema).min(3).max(8),
  claims: z.array(ClaimSchema).max(12),
});
export type Script = z.infer<typeof ScriptSchema>;

export interface GenerationMeta {
  /**
   * The trace id every log line and the JSONL record for this run carry, and
   * the key `POST /api/feedback` joins an accept/edit/discard on. Surfaced to
   * the client on purpose: a rating the browser cannot attach to a generation
   * is a rating of nothing.
   */
  generationId: string;
  model: string;
  provider: string;
  /**
   * Summed across both calls. A zero here across repeated generations with the
   * same profile is the canonical signal that the cacheable prefix has silently
   * started varying per request.
   */
  cacheReadTokens: number;
  latencyMs: number;
}

export interface GenerationResult {
  hooks: Hook[];
  script: Script;
  /**
   * Layer-1 verdicts for this run. Computed by the pipeline so that every real
   * generation leaves a per-check record behind, not just the ones an eval
   * harness happens to look at.
   *
   * `CheckResult` is imported as a type only, so this module still pulls no
   * filesystem or LLM code into the browser bundle.
   */
  checks: CheckResult[];
  meta: GenerationMeta;
}
