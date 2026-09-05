import { z } from "zod";

import { HookSchema, MAX_HOOKS, MIN_HOOKS, ScriptSchema } from "./generation.ts";
import { JudgeVerdictSchema } from "./judge.ts";

/**
 * The golden set: a small, fixed collection of representative ideas the eval
 * re-runs on every change.
 *
 * This is a regression suite, not a benchmark. There is no ground-truth "right
 * script" for a raw idea, so nothing here encodes a correct answer. What it
 * encodes is coverage — four content formats the creator actually posts — and
 * a stable input, so that a prompt edit which quietly breaks storytime while
 * improving tutorials is visible instead of averaging out.
 */

/** The four shapes this creator's Reels take. Coverage, not taxonomy. */
export const GOLDEN_FORMATS = [
  "tutorial",
  "storytime",
  "contrarian_take",
  "product",
] as const;
export const GoldenFormatSchema = z.enum(GOLDEN_FORMATS);
export type GoldenFormat = z.infer<typeof GoldenFormatSchema>;

/**
 * Tuning cases are fair game when iterating on prompts. Held-out cases are not,
 * ever — the moment a prompt is edited to make a held-out case score better,
 * the eval stops measuring generalisation and starts re-validating the examples
 * it was fitted to. That rule is a convention, not something code can enforce;
 * `lib/eval/golden.ts` exposes the split so the distinction is at least always
 * visible in the report.
 */
export const GOLDEN_SPLITS = ["tuning", "held_out"] as const;
export const GoldenSplitSchema = z.enum(GOLDEN_SPLITS);
export type GoldenSplit = z.infer<typeof GoldenSplitSchema>;

/**
 * The committed offline answer for one case.
 *
 * These exist so `npm test`, `npm run eval` and CI are deterministic and need
 * no API key. They are NOT reference outputs and they are not what a live model
 * produces — they are terse, hand-written stand-ins whose only job is to make
 * the harness exercisable end to end offline. Never tune a prompt to reproduce
 * one.
 */
export const GoldenOfflineSchema = z.object({
  hooks: z.array(HookSchema).min(MIN_HOOKS).max(MAX_HOOKS),
  script: ScriptSchema,
  judge: JudgeVerdictSchema,
});
export type GoldenOffline = z.infer<typeof GoldenOfflineSchema>;

export const GoldenCaseSchema = z.object({
  /** Stable, filename-safe, and used as the fixture key. */
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase, digits and dashes"),
  format: GoldenFormatSchema,
  split: GoldenSplitSchema,
  /** Why this case earns a slot in a twelve-case set. */
  covers: z.string().trim().min(1).max(300),
  /** The raw idea, exactly as the creator would type it into the box. */
  idea: z.string().trim().min(12).max(1200),
  hook_count: z.number().int().min(MIN_HOOKS).max(MAX_HOOKS),
  offline: GoldenOfflineSchema,
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
