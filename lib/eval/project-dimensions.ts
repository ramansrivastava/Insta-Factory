import { checkPassed, type GoldenCaseOutcome, type GoldenRunReport } from "./golden-run.ts";
import { JUDGE_FLOOR, meetsFloor } from "../../types/judge.ts";

/**
 * The four dimensions `factory.md` binds as this project's Project Eval.
 *
 * Each one answers the same question over the whole golden set: on how many of
 * the twelve cases did this hold? The score is a pass *rate*, never a quality
 * average — see `lib/eval/judge.ts` for why the judge's means are kept out of
 * anything the factory scores against.
 *
 * Three of the four are pure Layer-1 gates. Only `voice_match` reaches for the
 * judge, and only because voice is the one thing here that cannot be checked
 * deterministically: code can prove a banned phrase is absent, and nothing more.
 */

export const PROJECT_DIMENSIONS = [
  "hook_distinctiveness",
  "voice_match",
  "script_completeness",
  "groundedness",
] as const;
export type ProjectDimension = (typeof PROJECT_DIMENSIONS)[number];

export interface ProjectDimensionSpec {
  name: ProjectDimension;
  description: string;
  /** Whether scoring this dimension requires a judge call per case. */
  needsJudge: boolean;
  evaluate: (outcome: GoldenCaseOutcome) => { passed: boolean; reason: string };
}

function fromCheck(
  name: ProjectDimension,
  checkName: string,
  description: string,
): ProjectDimensionSpec {
  return {
    name,
    description,
    needsJudge: false,
    evaluate: (outcome) => {
      if (outcome.error) return { passed: false, reason: `generation failed: ${outcome.error}` };
      const check = outcome.checks.find((item) => item.name === checkName);
      if (!check) return { passed: false, reason: `no ${checkName} check was produced` };
      return { passed: check.passed, reason: check.details };
    },
  };
}

export const PROJECT_DIMENSION_SPECS: Record<ProjectDimension, ProjectDimensionSpec> = {
  hook_distinctiveness: fromCheck(
    "hook_distinctiveness",
    "hook_distinctiveness",
    "Every hook in a set takes a different angle, across all golden cases",
  ),

  script_completeness: fromCheck(
    "script_completeness",
    "section_completeness",
    "Every generated script carries a hook, a body and a CTA",
  ),

  groundedness: fromCheck(
    "groundedness",
    "groundedness",
    "No number, name or attributed claim appears that the creator's idea does not support",
  ),

  /**
   * The one dimension the judge is load-bearing for.
   *
   * Both halves must hold. The deterministic half catches the failure the
   * creator has explicitly named — a phrase on their banned list — and a judge
   * is not needed, or trusted, for that. The judge half catches the failure
   * that has no deterministic form: fluent, on-topic copy that sounds like
   * nobody. It is used as a floor only; a case that clears 3/5 contributes
   * exactly as much as one that scores 5/5.
   */
  voice_match: {
    name: "voice_match",
    description:
      "Output uses no banned phrase and clears the judge's voice-fidelity floor on every golden case",
    needsJudge: true,
    evaluate: (outcome) => {
      if (outcome.error) return { passed: false, reason: `generation failed: ${outcome.error}` };

      if (!checkPassed(outcome, "banned_phrases")) {
        const check = outcome.checks.find((item) => item.name === "banned_phrases");
        return { passed: false, reason: check?.details ?? "banned_phrases check missing" };
      }

      const voice = outcome.verdict?.voice_fidelity;
      if (!voice) {
        return { passed: false, reason: "no judge verdict — run this dimension with the judge enabled" };
      }

      return meetsFloor(voice.score)
        ? { passed: true, reason: `no banned phrases; judge voice_fidelity ${voice.score}/5 (floor ${JUDGE_FLOOR})` }
        : {
            passed: false,
            reason: `judge voice_fidelity ${voice.score}/5 is below the floor of ${JUDGE_FLOOR}: ${voice.evidence}`,
          };
    },
  },
};

export interface ProjectDimensionResult {
  /** 0–1, the share of golden cases on which the dimension held. */
  score: number;
  details: string;
}

export function isProjectDimension(name: string): name is ProjectDimension {
  return (PROJECT_DIMENSIONS as readonly string[]).includes(name);
}

/**
 * Scores one dimension over a completed golden run.
 *
 * Failures are named individually in `details` rather than counted. A rate on
 * its own tells whoever reads the eval that something regressed; the case ids
 * tell them where to look, which is the difference between an actionable eval
 * and a number that makes people shrug.
 */
export function scoreProjectDimension(
  dimension: ProjectDimension,
  report: GoldenRunReport,
): ProjectDimensionResult {
  const spec = PROJECT_DIMENSION_SPECS[dimension];
  const total = report.outcomes.length;

  if (total === 0) {
    return { score: 0, details: "the golden set is empty — nothing was scored" };
  }

  const failures: string[] = [];
  for (const outcome of report.outcomes) {
    const verdict = spec.evaluate(outcome);
    if (!verdict.passed) failures.push(`${outcome.id} (${outcome.format}): ${verdict.reason}`);
  }

  const passing = total - failures.length;
  const score = passing / total;

  const header = `${passing}/${total} golden cases pass ${dimension} (${report.counts.tuning} tuning, ${report.counts.held_out} held out; provider ${report.provider})`;

  return {
    score,
    details: failures.length === 0 ? header : `${header}. Failures: ${failures.join(" | ")}`,
  };
}
