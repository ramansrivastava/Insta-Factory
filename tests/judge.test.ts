import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadGoldenCases } from "@/lib/eval/golden.ts";
import {
  DEFAULT_JUDGE_MODEL,
  JudgeConfigError,
  flaggedDimensions,
  getJudgeAdapter,
  judgeGeneration,
  judgeSharesGeneratorModel,
  normalisedMean,
  resolveJudgeModel,
  summariseDimension,
  summariseJudgement,
  toEvalResult,
  type JudgedCase,
} from "@/lib/eval/judge.ts";
import { JUDGE_KIND, buildJudgeRequest } from "@/lib/eval/judge-prompt.ts";
import { RUBRIC, RUBRICS, renderAllRubrics, renderRubric } from "@/lib/eval/rubric.ts";
import { buildVoiceSystemBlocks } from "@/lib/prompts/system.ts";
import {
  PROJECT_DIMENSION_SPECS,
  scoreProjectDimension,
} from "@/lib/eval/project-dimensions.ts";
import { DEFAULT_MODEL } from "@/lib/llm/index.ts";
import {
  JUDGE_DIMENSIONS,
  JUDGE_FLOOR,
  JUDGE_SCALE_MAX,
  JUDGE_SCALE_MIN,
  JudgeVerdictSchema,
  meetsFloor,
  normalizeJudgeScore,
  type JudgeVerdict,
} from "@/types/judge.ts";
import { VoiceProfileSchema, type VoiceProfile } from "@/types/voice.ts";
import type { GoldenCaseOutcome, GoldenRunReport } from "@/lib/eval/golden-run.ts";

const profile: VoiceProfile = VoiceProfileSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "data/voice-profile.example.json"), "utf8"),
  ),
);

const goldenCase = loadGoldenCases()[0]!;

function verdict(scores: Partial<Record<(typeof JUDGE_DIMENSIONS)[number], number>>): JudgeVerdict {
  return JudgeVerdictSchema.parse(
    Object.fromEntries(
      JUDGE_DIMENSIONS.map((dimension) => [
        dimension,
        { score: scores[dimension] ?? 5, evidence: `evidence for ${dimension}` },
      ]),
    ),
  );
}

describe("the verdict shape", () => {
  it("scores exactly the four narrow dimensions", () => {
    expect([...JUDGE_DIMENSIONS]).toEqual([
      "voice_fidelity",
      "hook_distinctiveness",
      "script_completeness",
      "instruction_adherence",
    ]);
  });

  it("carries no holistic score to blend them into", () => {
    const keys = Object.keys(JudgeVerdictSchema.parse(verdict({})));
    expect(keys).toEqual([...JUDGE_DIMENSIONS]);
  });

  it("requires evidence alongside every number", () => {
    const missing = JudgeVerdictSchema.safeParse({
      ...verdict({}),
      voice_fidelity: { score: 4 },
    });
    expect(missing.success).toBe(false);
  });

  it("holds scores to whole numbers on a 1-5 scale", () => {
    for (const bad of [0, 6, 3.5]) {
      const parsed = JudgeVerdictSchema.safeParse({
        ...verdict({}),
        voice_fidelity: { score: bad, evidence: "x" },
      });
      expect(parsed.success, `score ${bad} should be rejected`).toBe(false);
    }
  });

  it("treats the floor as the only judgement acted on", () => {
    expect(meetsFloor(JUDGE_FLOOR)).toBe(true);
    expect(meetsFloor(JUDGE_FLOOR - 1)).toBe(false);
  });

  it("normalises 1-5 onto 0-1 and clamps outside it", () => {
    expect(normalizeJudgeScore(JUDGE_SCALE_MIN)).toBe(0);
    expect(normalizeJudgeScore(JUDGE_SCALE_MAX)).toBe(1);
    expect(normalizeJudgeScore(3)).toBeCloseTo(0.5);
    expect(normalizeJudgeScore(99)).toBe(1);
  });
});

describe("judge configuration is separate from generation", () => {
  it("defaults to a different model than generation uses", () => {
    expect(DEFAULT_JUDGE_MODEL).not.toBe(DEFAULT_MODEL);
    expect(resolveJudgeModel({})).toBe(DEFAULT_JUDGE_MODEL);
  });

  it("reads JUDGE_MODEL, never LLM_MODEL", () => {
    expect(resolveJudgeModel({ JUDGE_MODEL: "some-other-model" })).toBe("some-other-model");
    expect(resolveJudgeModel({ LLM_MODEL: "claude-sonnet-5" })).toBe(DEFAULT_JUDGE_MODEL);
  });

  it("treats a blank JUDGE_MODEL as unset", () => {
    expect(resolveJudgeModel({ JUDGE_MODEL: "   " })).toBe(DEFAULT_JUDGE_MODEL);
  });

  it("flags the case where the model would grade its own output", () => {
    expect(judgeSharesGeneratorModel({ LLM_MODEL: "m", JUDGE_MODEL: "m" })).toBe(true);
    expect(judgeSharesGeneratorModel({ LLM_MODEL: "m", JUDGE_MODEL: "n" })).toBe(false);
    expect(judgeSharesGeneratorModel({ JUDGE_MODEL: DEFAULT_JUDGE_MODEL })).toBe(false);
  });
});

describe("the judge adapter", () => {
  it("answers from the committed verdict on the mock provider", async () => {
    const adapter = getJudgeAdapter({
      env: { LLM_PROVIDER: "mock" },
      offlineVerdict: goldenCase.offline.judge,
    });

    const result = await judgeGeneration({
      adapter,
      idea: goldenCase.idea,
      profile,
      hooks: goldenCase.offline.hooks,
      script: goldenCase.offline.script,
      hookCount: goldenCase.hook_count,
    });

    expect(result.provider).toBe("mock");
    expect(result.verdict).toEqual(goldenCase.offline.judge);
  });

  // Without this the offline eval would go green having graded nothing.
  it("refuses to run offline without a committed verdict", () => {
    expect(() => getJudgeAdapter({ env: { LLM_PROVIDER: "mock" } })).toThrow(JudgeConfigError);
  });

  it("uses JUDGE_MODEL when a key is present", () => {
    const adapter = getJudgeAdapter({
      env: { ANTHROPIC_API_KEY: "sk-test", LLM_MODEL: "claude-sonnet-5", JUDGE_MODEL: "judge-x" },
    });
    expect(adapter.provider).toBe("anthropic");
    expect(adapter.model).toBe("judge-x");
  });
});

describe("the rubric", () => {
  it("carries one rubric per dimension, in canonical order", () => {
    expect(RUBRICS.map((item) => item.dimension)).toEqual([...JUDGE_DIMENSIONS]);
  });

  it("states criteria, an exclusion, and both calibration anchors everywhere", () => {
    for (const rubric of RUBRICS) {
      expect(rubric.criteria.length).toBeGreaterThan(2);
      expect(rubric.notAsking).toMatch(/NOT/);
      expect(rubric.exemplarFive.example.length).toBeGreaterThan(20);
      expect(rubric.exemplarFive.because.length).toBeGreaterThan(20);
      expect(rubric.exemplarTwo.example.length).toBeGreaterThan(20);
      expect(rubric.exemplarTwo.because.length).toBeGreaterThan(20);
    }
  });

  it("renders deterministically", () => {
    expect(renderAllRubrics()).toBe(renderAllRubrics());
  });

  it("puts the anchors in the rendered text, since that is what calibrates", () => {
    const rendered = renderRubric(RUBRIC.voice_fidelity);
    expect(rendered).toContain(RUBRIC.voice_fidelity.exemplarFive.example);
    expect(rendered).toContain(RUBRIC.voice_fidelity.exemplarTwo.example);
    expect(rendered).toContain(RUBRIC.voice_fidelity.notAsking);
  });
});

describe("the judge request", () => {
  const request = buildJudgeRequest({
    idea: goldenCase.idea,
    profile,
    hooks: goldenCase.offline.hooks,
    script: goldenCase.offline.script,
    hookCount: goldenCase.hook_count,
  });

  it("is one structured call covering all four dimensions", () => {
    expect(request.kind).toBe(JUDGE_KIND);
    expect(request.schema).toBe(JudgeVerdictSchema);
    for (const dimension of JUDGE_DIMENSIONS) {
      expect(request.system.map((block) => block.text).join("\n")).toContain(dimension);
    }
  });

  it("forbids an overall score in the framing", () => {
    expect(request.system[0]!.text).toContain("NO OVERALL SCORE");
  });

  it("caches the whole system prefix, which is stable across cases", () => {
    expect(request.system.every((block) => block.cacheable)).toBe(true);
  });

  it("shows the judge the idea and the draft", () => {
    const user = request.messages[0]!.content;
    expect(user).toContain(goldenCase.idea);
    expect(user).toContain(goldenCase.offline.hooks[0]!.text);
    expect(user).toContain(`requested="${goldenCase.hook_count}"`);
  });

  // Showing the judge the generator's instructions invites it to grade
  // compliance with the prompt instead of the draft the creator has to film.
  it("does not show it the generator's role framing", () => {
    const everything = [
      ...request.system.map((block) => block.text),
      ...request.messages.map((message) => message.content),
    ].join("\n");
    const generatorFraming = buildVoiceSystemBlocks(profile)[0]!.text;

    expect(generatorFraming.length).toBeGreaterThan(0);
    expect(everything).not.toContain(generatorFraming);
  });

  it("names the claim spans so instruction_adherence can be checked", () => {
    const user = request.messages[0]!.content;
    for (const claim of goldenCase.offline.script.claims) {
      expect(user).toContain(claim.grounded_in);
    }
  });
});

describe("summarising verdicts", () => {
  const cases: JudgedCase[] = [
    { id: "a", verdict: verdict({ voice_fidelity: 5 }) },
    { id: "b", verdict: verdict({ voice_fidelity: 2 }) },
    { id: "c", verdict: verdict({ voice_fidelity: 3 }) },
    { id: "d", verdict: verdict({ voice_fidelity: 1 }) },
  ];

  it("reports the floor pass rate and names the cases under it", () => {
    const summary = summariseDimension("voice_fidelity", cases);
    expect(summary.floorPassRate).toBe(0.5);
    expect(summary.flagged).toEqual(["b", "d"]);
    expect(summary.min).toBe(1);
    expect(summary.mean).toBeCloseTo(2.75);
  });

  it("summarises every dimension", () => {
    expect(summariseJudgement(cases).map((item) => item.dimension)).toEqual([
      ...JUDGE_DIMENSIONS,
    ]);
  });

  it("survives an empty set rather than dividing by zero", () => {
    expect(summariseDimension("voice_fidelity", [])).toEqual({
      dimension: "voice_fidelity",
      mean: 0,
      min: 0,
      floorPassRate: 0,
      flagged: [],
    });
  });

  it("lists the dimensions of one verdict that are under the floor", () => {
    expect(flaggedDimensions(verdict({ voice_fidelity: 2, script_completeness: 1 }))).toEqual([
      "voice_fidelity",
      "script_completeness",
    ]);
    expect(flaggedDimensions(verdict({}))).toEqual([]);
  });

  // The whole argument of Layer 2, expressed as one assertion: a run of 3s and
  // a run of 5s score the same, so there is nothing to hill-climb.
  it("scores the pass rate, not the mean", () => {
    const scraped: JudgedCase[] = [{ id: "a", verdict: verdict({ voice_fidelity: 3 }) }];
    const excellent: JudgedCase[] = [{ id: "a", verdict: verdict({ voice_fidelity: 5 }) }];

    const scrapedResult = toEvalResult(summariseDimension("voice_fidelity", scraped), 0.05, 1);
    const excellentResult = toEvalResult(summariseDimension("voice_fidelity", excellent), 0.05, 1);

    expect(scrapedResult.score).toBe(excellentResult.score);
    expect(scrapedResult.passed).toBe(true);
  });

  it("fails and names the offenders when a case is under the floor", () => {
    const result = toEvalResult(summariseDimension("voice_fidelity", cases), 0.05, cases.length);

    expect(result.name).toBe("judge_voice_fidelity");
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.5);
    expect(result.weight).toBe(0.05);
    expect(result.details).toContain("b, d");
  });

  it("labels a passing run as triage rather than a ranking", () => {
    const passing: JudgedCase[] = [{ id: "a", verdict: verdict({}) }];
    const result = toEvalResult(summariseDimension("voice_fidelity", passing), 0.05, 1);
    expect(result.details).toContain("triage only");
  });

  it("normalises a mean only for reporting", () => {
    expect(normalisedMean(summariseDimension("voice_fidelity", cases))).toBeCloseTo(0.4375);
  });
});

describe("the project dimensions", () => {
  function outcome(overrides: Partial<GoldenCaseOutcome> = {}): GoldenCaseOutcome {
    return {
      id: "case",
      format: "tutorial",
      split: "tuning",
      idea: goldenCase.idea,
      hookCount: goldenCase.hook_count,
      hooks: goldenCase.offline.hooks,
      script: goldenCase.offline.script,
      checks: [
        { name: "banned_phrases", passed: true, score: 1, details: "none found" },
        { name: "hook_distinctiveness", passed: true, score: 1, details: "all distinct" },
        { name: "section_completeness", passed: true, score: 1, details: "hook, body, cta" },
        { name: "groundedness", passed: true, score: 1, details: "grounded" },
      ],
      verdict: verdict({}),
      ...overrides,
    };
  }

  function report(outcomes: GoldenCaseOutcome[]): GoldenRunReport {
    return {
      provider: "mock",
      outcomes,
      withJudge: true,
      counts: { tuning: outcomes.length, held_out: 0 },
    };
  }

  it("marks voice_match as the only dimension the judge is load-bearing for", () => {
    const needsJudge = Object.values(PROJECT_DIMENSION_SPECS)
      .filter((spec) => spec.needsJudge)
      .map((spec) => spec.name);
    expect(needsJudge).toEqual(["voice_match"]);
  });

  it("requires both halves of voice_match", () => {
    const banned = PROJECT_DIMENSION_SPECS.voice_match.evaluate(
      outcome({
        checks: [
          { name: "banned_phrases", passed: false, score: 0, details: "found 'game changer'" },
        ],
      }),
    );
    expect(banned.passed).toBe(false);
    expect(banned.reason).toContain("game changer");

    const belowFloor = PROJECT_DIMENSION_SPECS.voice_match.evaluate(
      outcome({ verdict: verdict({ voice_fidelity: 2 }) }),
    );
    expect(belowFloor.passed).toBe(false);
    expect(belowFloor.reason).toContain("below the floor");

    expect(PROJECT_DIMENSION_SPECS.voice_match.evaluate(outcome()).passed).toBe(true);
  });

  it("counts a case that failed to generate as a failure of every dimension", () => {
    const broken = report([outcome({ error: "the model timed out" })]);
    for (const spec of Object.values(PROJECT_DIMENSION_SPECS)) {
      expect(spec.evaluate(broken.outcomes[0]!).passed, spec.name).toBe(false);
    }
    expect(scoreProjectDimension("groundedness", broken).score).toBe(0);
  });

  it("scores the share of cases that held, and names where to look", () => {
    const mixed = report([
      outcome({ id: "good" }),
      outcome({ id: "bad", verdict: verdict({ voice_fidelity: 1 }) }),
    ]);
    const scored = scoreProjectDimension("voice_match", mixed);

    expect(scored.score).toBe(0.5);
    expect(scored.details).toContain("1/2");
    expect(scored.details).toContain("bad (tutorial)");
  });

  it("scores an empty run as zero rather than as a vacuous pass", () => {
    expect(scoreProjectDimension("voice_match", report([])).score).toBe(0);
  });

  it("treats a missing check as a failure, not as absent evidence", () => {
    const missing = PROJECT_DIMENSION_SPECS.groundedness.evaluate(outcome({ checks: [] }));
    expect(missing.passed).toBe(false);
  });
});

