import { AnthropicAdapter, MockAdapter, resolveProvider } from "../llm/index.ts";
import { buildJudgeRequest, type JudgeRequestInput } from "./judge-prompt.ts";
import { JUDGE_KIND } from "./judge-prompt.ts";
import type { LlmAdapter, LlmProvider } from "../llm/types.ts";
import {
  JUDGE_DIMENSIONS,
  JUDGE_FLOOR,
  meetsFloor,
  normalizeJudgeScore,
  type JudgeDimension,
  type JudgeVerdict,
} from "../../types/judge.ts";

/**
 * Layer 2: the judge, and what its scores are allowed to mean.
 *
 * Two decisions here are worth more than the code.
 *
 * **The judge is configured separately from the generator.** `JUDGE_MODEL` is
 * its own variable, defaulting to a different model than generation uses, so a
 * model is never grading its own output. Self-preference bias is well
 * documented and it is invisible in the score — a judge marks its own family's
 * phrasing up and nothing in the number says so. A different family would be
 * better still; a different model is what this project can reach today, and
 * `docs/eval.md` records the gap.
 *
 * **The scores gate, they do not rank.** Everything below reduces to one
 * question per dimension: is any case under the floor? A mean is reported
 * because it is useful to a human reading a report, but no code path anywhere
 * compares one run's mean to another's and calls the higher one better.
 */

/**
 * Deliberately not `DEFAULT_MODEL` from the generation adapter. If this ever
 * matches `LLM_MODEL`, the judge is grading its own writing.
 */
export const DEFAULT_JUDGE_MODEL = "claude-opus-5";

type Env = Record<string, string | undefined>;

export function resolveJudgeModel(env: Env = process.env): string {
  return env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
}

/** True when the judge would grade its own output. Surfaced as a warning. */
export function judgeSharesGeneratorModel(env: Env = process.env): boolean {
  const generator = env.LLM_MODEL?.trim();
  return Boolean(generator) && generator === resolveJudgeModel(env);
}

export interface JudgeAdapterOptions {
  env?: Env;
  /**
   * The committed verdict for this case, used when the resolved provider is the
   * mock. Offline the judge still goes through `buildJudgeRequest` and the same
   * `LlmAdapter` interface — the request is built, the schema is enforced, the
   * result is parsed — it just answers from a fixture instead of the network.
   * That is what keeps CI green and deterministic without a key while still
   * exercising the code path that runs with one.
   */
  offlineVerdict?: JudgeVerdict;
}

export class JudgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeConfigError";
  }
}

/**
 * The judge's own adapter.
 *
 * `resolveProvider` is shared with generation so that `LLM_PROVIDER=mock` puts
 * the whole eval offline in one switch, but the model is not: the judge gets
 * `JUDGE_MODEL`, never `LLM_MODEL`.
 */
export function getJudgeAdapter(options: JudgeAdapterOptions = {}): LlmAdapter {
  const env = options.env ?? process.env;
  const provider: LlmProvider = resolveProvider(env);

  if (provider === "mock") {
    if (!options.offlineVerdict) {
      throw new JudgeConfigError(
        "The judge is running on the mock provider but no offline verdict was supplied. Every golden case must commit one under `offline.judge`, so the eval is deterministic without an API key.",
      );
    }
    return new MockAdapter({ fixtures: { [JUDGE_KIND]: options.offlineVerdict } });
  }

  return new AnthropicAdapter({
    apiKey: env.ANTHROPIC_API_KEY as string,
    model: resolveJudgeModel(env),
  });
}

export interface JudgeGenerationInput extends JudgeRequestInput {
  adapter: LlmAdapter;
}

/** One structured judge call. */
export async function judgeGeneration(
  input: JudgeGenerationInput,
): Promise<{ verdict: JudgeVerdict; model: string; provider: LlmProvider }> {
  const { adapter, ...request } = input;
  const result = await adapter.generateStructured(buildJudgeRequest(request));
  return { verdict: result.data, model: result.model, provider: result.provider };
}

/** Dimensions of this verdict that fall below the triage floor. */
export function flaggedDimensions(verdict: JudgeVerdict): JudgeDimension[] {
  return JUDGE_DIMENSIONS.filter((dimension) => !meetsFloor(verdict[dimension].score));
}

export interface JudgedCase {
  id: string;
  verdict: JudgeVerdict;
}

export interface DimensionSummary {
  dimension: JudgeDimension;
  /** Mean 1–5 across cases. Context for a human; never a ranking key. */
  mean: number;
  min: number;
  /** Share of cases at or above the floor. This is the number that gates. */
  floorPassRate: number;
  /** Ids under the floor — the whole point of the exercise. */
  flagged: string[];
}

export function summariseDimension(
  dimension: JudgeDimension,
  cases: readonly JudgedCase[],
): DimensionSummary {
  if (cases.length === 0) {
    return { dimension, mean: 0, min: 0, floorPassRate: 0, flagged: [] };
  }

  const scores = cases.map((item) => item.verdict[dimension].score);
  const flagged = cases
    .filter((item) => !meetsFloor(item.verdict[dimension].score))
    .map((item) => item.id);

  return {
    dimension,
    mean: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    min: Math.min(...scores),
    floorPassRate: (cases.length - flagged.length) / cases.length,
    flagged,
  };
}

export function summariseJudgement(cases: readonly JudgedCase[]): DimensionSummary[] {
  return JUDGE_DIMENSIONS.map((dimension) => summariseDimension(dimension, cases));
}

export interface JudgeEvalResult {
  name: string;
  score: number;
  weight: number;
  passed: boolean;
  details: string;
}

/**
 * A dimension summary as an eval result.
 *
 * `score` is the floor pass rate, not the normalised mean. That is the whole
 * argument of this layer expressed as one line of code: the reported number
 * answers "how many cases are clearly broken", and a run where every case
 * scraped a 3 scores identically to one where every case earned a 5. There is
 * nothing to hill-climb here, which is the intent — the moment a judge mean
 * becomes a target, the prompts get tuned to the judge's taste instead of the
 * creator's.
 */
export function toEvalResult(
  summary: DimensionSummary,
  weight: number,
  caseCount: number,
): JudgeEvalResult {
  const passed = summary.flagged.length === 0;
  const mean = summary.mean.toFixed(2);

  const details = passed
    ? `${caseCount}/${caseCount} golden cases at or above the floor of ${JUDGE_FLOOR}/5 (mean ${mean}, min ${summary.min}) — triage only, not a quality ranking`
    : `${summary.flagged.length} of ${caseCount} golden cases below the floor of ${JUDGE_FLOOR}/5 (mean ${mean}, min ${summary.min}): ${summary.flagged.join(", ")} — read these by hand before trusting the run`;

  return {
    name: `judge_${summary.dimension}`,
    score: summary.floorPassRate,
    weight,
    passed,
    details,
  };
}

/** Normalised 0–1 means, for reports that want one. Not used for gating. */
export function normalisedMean(summary: DimensionSummary): number {
  return normalizeJudgeScore(summary.mean);
}
