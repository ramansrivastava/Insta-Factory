import { z } from "zod";

/**
 * Layer 2 of the eval strategy: the LLM-as-judge verdict shape.
 *
 * Four narrow dimensions, each scored 1–5 with a one-line piece of evidence.
 * There is deliberately no holistic "rate this Reel 1–10" field, and there
 * never should be. Judges are markedly more reliable when asked a concrete
 * question with stated criteria than when asked for a broad subjective
 * impression, and a single blended number also destroys the only thing a judge
 * score is actually good for here: telling you *which* thing went wrong.
 *
 * The `evidence` string is required for the same reason. A score with no quoted
 * justification is unauditable, and asking for the justification alongside the
 * number is what stops the model from picking a comfortable middle value.
 */

export const JUDGE_DIMENSIONS = [
  "voice_fidelity",
  "hook_distinctiveness",
  "script_completeness",
  "instruction_adherence",
] as const;

export const JudgeDimensionSchema = z.enum(JUDGE_DIMENSIONS);
export type JudgeDimension = z.infer<typeof JudgeDimensionSchema>;

export const JUDGE_SCALE_MIN = 1;
export const JUDGE_SCALE_MAX = 5;

/**
 * The triage floor.
 *
 * Below this a generation is flagged for a human to look at. At or above it,
 * nothing further is claimed — a 4 is not "better than" a 3 in any way this
 * project acts on. LLM judges are weakest at exactly the fine-grained creative
 * discrimination that ranking would require, so this eval only ever asks the
 * one question a judge can answer reliably: is this clearly broken?
 */
export const JUDGE_FLOOR = 3;

export const JudgeScoreSchema = z.object({
  score: z.number().int().min(JUDGE_SCALE_MIN).max(JUDGE_SCALE_MAX),
  /** One sentence, quoting the output. Checked by humans, not by code. */
  evidence: z.string().trim().min(1).max(600),
});
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;

/**
 * One verdict per generation. A flat object rather than an array so the
 * provider's structured-output format requires all four dimensions — an array
 * lets the model return three and there is no way to tell that apart from an
 * opinion.
 */
export const JudgeVerdictSchema = z.object({
  voice_fidelity: JudgeScoreSchema,
  hook_distinctiveness: JudgeScoreSchema,
  script_completeness: JudgeScoreSchema,
  instruction_adherence: JudgeScoreSchema,
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** 1–5 onto 0–1, for reporting only. Never used to rank one run above another. */
export function normalizeJudgeScore(score: number): number {
  const clamped = Math.min(JUDGE_SCALE_MAX, Math.max(JUDGE_SCALE_MIN, score));
  return (clamped - JUDGE_SCALE_MIN) / (JUDGE_SCALE_MAX - JUDGE_SCALE_MIN);
}

/** The only judgement this project acts on. */
export function meetsFloor(score: number): boolean {
  return score >= JUDGE_FLOOR;
}
