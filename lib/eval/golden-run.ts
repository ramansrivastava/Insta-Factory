import { generate } from "../generate/pipeline.ts";
import { MockAdapter, resolveProvider } from "../llm/index.ts";
import { hooksRequestKind } from "../prompts/hooks.ts";
import { SCRIPT_KIND } from "../prompts/script.ts";
import { loadVoiceProfile } from "../voice/store.ts";
import { getJudgeAdapter, judgeGeneration } from "./judge.ts";
import { loadGoldenCases, splitCounts, type LoadGoldenOptions } from "./golden.ts";
import type { CheckResult } from "../generate/checks.ts";
import type { LlmAdapter } from "../llm/types.ts";
import type { Hook, Script } from "../../types/generation.ts";
import type { GoldenCase, GoldenFormat, GoldenSplit } from "../../types/golden.ts";
import type { JudgeVerdict } from "../../types/judge.ts";
import type { VoiceProfile } from "../../types/voice.ts";

/**
 * Runs the golden set through the real pipeline, and optionally through the
 * judge.
 *
 * The pipeline is the same `generate()` the API route and the CLI call — the
 * eval does not get its own code path, because an eval that exercises a
 * parallel implementation measures the parallel implementation.
 *
 * What differs offline is only the adapter. With `LLM_PROVIDER=mock` each case
 * supplies its own committed hooks and script through `MockAdapter`'s in-memory
 * fixtures, rather than every case receiving the one shared fixture in
 * `fixtures/llm/`. That distinction matters: the shared fixture is grounded in
 * one specific idea, so running twelve different ideas against it would fail
 * `groundedness` eleven times and the eval would be reporting an artefact of
 * the mock rather than anything about the product.
 */

export interface GoldenCaseOutcome {
  id: string;
  format: GoldenFormat;
  split: GoldenSplit;
  idea: string;
  hookCount: number;
  hooks: Hook[];
  script: Script;
  checks: CheckResult[];
  verdict?: JudgeVerdict;
  judgeModel?: string;
  /** Set when the case could not be run at all; every check counts as failed. */
  error?: string;
}

export interface GoldenRunReport {
  provider: string;
  outcomes: GoldenCaseOutcome[];
  withJudge: boolean;
  counts: Record<GoldenSplit, number>;
}

export interface RunGoldenOptions extends LoadGoldenOptions {
  env?: Record<string, string | undefined>;
  withJudge?: boolean;
  /** Injected by tests; production loads the committed profile. */
  profile?: VoiceProfile;
  /** Progress line per case. Defaults to silence. */
  onProgress?: (message: string) => void;
}

/**
 * The mock adapter for one case, seeded from its committed offline generation.
 *
 * Keyed by the same `kind` values the prompt builders produce, so the fixture
 * lookup exercises the real request shape rather than a bypass.
 */
export function offlineGenerationAdapter(goldenCase: GoldenCase): LlmAdapter {
  return new MockAdapter({
    fixtures: {
      [hooksRequestKind(goldenCase.hook_count)]: { hooks: goldenCase.offline.hooks },
      [SCRIPT_KIND]: goldenCase.offline.script,
    },
  });
}

export interface RunGoldenCaseOptions {
  profile: VoiceProfile;
  env?: Record<string, string | undefined>;
  withJudge?: boolean;
}

export async function runGoldenCase(
  goldenCase: GoldenCase,
  options: RunGoldenCaseOptions,
): Promise<GoldenCaseOutcome> {
  const env = options.env ?? process.env;
  const offline = resolveProvider(env) === "mock";

  const base = {
    id: goldenCase.id,
    format: goldenCase.format,
    split: goldenCase.split,
    idea: goldenCase.idea,
    hookCount: goldenCase.hook_count,
  };

  try {
    const result = await generate({
      idea: goldenCase.idea,
      profile: options.profile,
      hookCount: goldenCase.hook_count,
      adapter: offline ? offlineGenerationAdapter(goldenCase) : undefined,
      env,
      // An eval run is not a creator's generation; writing it to the JSONL
      // trace would poison the accept/edit/discard dataset Layer 3 depends on
      // with twelve synthetic records per eval.
      trace: { enabled: false },
    });

    const outcome: GoldenCaseOutcome = {
      ...base,
      hooks: result.hooks,
      script: result.script,
      checks: result.checks,
    };

    if (options.withJudge) {
      const judged = await judgeGeneration({
        idea: goldenCase.idea,
        profile: options.profile,
        hooks: result.hooks,
        script: result.script,
        hookCount: goldenCase.hook_count,
        adapter: getJudgeAdapter({ env, offlineVerdict: goldenCase.offline.judge }),
      });
      outcome.verdict = judged.verdict;
      outcome.judgeModel = judged.model;
    }

    return outcome;
  } catch (error) {
    return {
      ...base,
      hooks: [],
      script: { sections: [], claims: [] },
      checks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runGoldenSet(
  options: RunGoldenOptions = {},
): Promise<GoldenRunReport> {
  const env = options.env ?? process.env;
  const cases = loadGoldenCases(options);
  const profile =
    options.profile ?? loadVoiceProfile({ fallbackToExample: true }).profile;

  const outcomes: GoldenCaseOutcome[] = [];
  for (const goldenCase of cases) {
    options.onProgress?.(`[golden] ${goldenCase.id} (${goldenCase.split}) ...`);
    outcomes.push(
      await runGoldenCase(goldenCase, {
        profile,
        env,
        withJudge: options.withJudge,
      }),
    );
  }

  return {
    provider: resolveProvider(env),
    outcomes,
    withJudge: Boolean(options.withJudge),
    counts: splitCounts(cases),
  };
}

/** A named Layer-1 check's verdict for one case. Missing counts as failed. */
export function checkPassed(outcome: GoldenCaseOutcome, name: string): boolean {
  return outcome.checks.some((check) => check.name === name && check.passed);
}
