#!/usr/bin/env node
/**
 * Layer 2 of the eval strategy: the golden set, run through the real pipeline
 * and graded by an LLM judge.
 *
 * Twelve fixed ideas (`fixtures/golden/cases/`) go through the same
 * `generate()` the UI and the CLI call. Each result gets the deterministic
 * Layer-1 checks plus one structured judge call scoring four narrow dimensions
 * 1-5. What comes out is the four dimensions `factory.md` binds as this
 * project's Project Eval:
 *
 *   hook_distinctiveness  every hook in a set takes a different angle
 *   voice_match           no banned phrase, and the judge's voice floor is met
 *   script_completeness   hook, body and CTA all present
 *   groundedness          no number, name or claim the idea does not support
 *
 * Three of those are pure Layer-1 gates. Only `voice_match` needs the judge,
 * because voice is the one thing here code cannot check.
 *
 * The judge is a TRIAGE signal. Every score reported below is a floor pass
 * rate, never a mean, and nothing in this file ranks one run above another on
 * judge quality. Means are printed for a human to read and are deliberately
 * not what gets scored — the moment a judge mean becomes a target, the prompts
 * get tuned to the judge's taste instead of the creator's.
 *
 * Offline (`LLM_PROVIDER=mock`, or simply no API key) both the generation and
 * the judge answer from each case's committed `offline` block, so this is
 * deterministic and needs no key. Those fixtures are hand-written stand-ins,
 * not reference outputs: offline this proves the harness works end to end, and
 * nothing about the model.
 *
 * Usage:
 *   node scripts/eval/judge.mjs                       # full report, judge on
 *   node scripts/eval/judge.mjs --split held_out      # only the held-out four
 *   node scripts/eval/judge.mjs --case tutorial-grip-fix
 *   node scripts/eval/judge.mjs --no-judge            # Layer-1 over the set
 *   node scripts/eval/judge.mjs --json                # {"results":[...]}
 *   node scripts/eval/judge.mjs --dimension voice_match
 *
 * Environment:
 *   JUDGE_MODEL    model that grades (separate from LLM_MODEL, on purpose)
 *   LLM_PROVIDER   `mock` forces the offline path for both calls
 */

// Before anything pulls in `lib/log.ts`: the pipeline logs one JSON line per
// phase to stdout, and stdout here has to stay parseable as a single object.
// An operator who explicitly asked for logs still gets them.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "silent";

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { runGoldenSet } = await import(path.join(ROOT, "lib/eval/golden-run.ts"));
const { PROJECT_DIMENSIONS, PROJECT_DIMENSION_SPECS, isProjectDimension, scoreProjectDimension } =
  await import(path.join(ROOT, "lib/eval/project-dimensions.ts"));
const { judgeSharesGeneratorModel, resolveJudgeModel, summariseJudgement, toEvalResult } =
  await import(path.join(ROOT, "lib/eval/judge.ts"));
const { GOLDEN_HELD_OUT_SIZE, GOLDEN_SET_SIZE, GOLDEN_TUNING_SIZE } = await import(
  path.join(ROOT, "lib/eval/golden.ts")
);
const { JUDGE_DIMENSIONS, JUDGE_FLOOR } = await import(path.join(ROOT, "types/judge.ts"));
const { GOLDEN_SPLITS } = await import(path.join(ROOT, "types/golden.ts"));

const USAGE = `node scripts/eval/judge.mjs [options]

  --split <${GOLDEN_SPLITS.join("|")}>   Run one half of the set. Default: all ${GOLDEN_SET_SIZE} cases
                             (${GOLDEN_TUNING_SIZE} tuning, ${GOLDEN_HELD_OUT_SIZE} held out).
  --case <id>                Run one case. Repeatable.
  --dimension <name>         Print one project dimension as JSON, for the
                             \`## Project Eval\` binding in factory.md.
                             One of: ${PROJECT_DIMENSIONS.join(", ")}.
  --no-judge                 Skip the judge call. Only the deterministic
                             dimensions are reported.
  --json                     Emit {"results":[...]} instead of the report.
  --help                     This.`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { split: null, ids: [], dimension: null, json: false, withJudge: true, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === "--split") {
      if (!GOLDEN_SPLITS.includes(value)) {
        throw new Error(`--split takes one of: ${GOLDEN_SPLITS.join(", ")}.`);
      }
      args.split = value;
      i += 1;
    } else if (arg === "--case") {
      if (!value) throw new Error("--case needs a golden case id.");
      args.ids.push(value);
      i += 1;
    } else if (arg === "--dimension") {
      if (!isProjectDimension(value)) {
        throw new Error(`--dimension takes one of: ${PROJECT_DIMENSIONS.join(", ")}.`);
      }
      args.dimension = value;
      i += 1;
    } else if (arg === "--no-judge") {
      args.withJudge = false;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument ${arg}. Try --help.`);
    }
  }

  return args;
}

/**
 * Which project dimensions this invocation can honestly report.
 *
 * With the judge off, `voice_match` is dropped rather than scored on its
 * deterministic half alone. A dimension that quietly measures less than its
 * name claims is worse than a missing one — the run would go green having
 * checked only that no banned phrase appeared.
 * @param {{withJudge: boolean, dimension: string | null}} args
 */
function selectedDimensions(args) {
  const wanted = args.dimension ? [args.dimension] : [...PROJECT_DIMENSIONS];
  return wanted.filter((name) => args.withJudge || !PROJECT_DIMENSION_SPECS[name].needsJudge);
}

/**
 * Weights across whatever is being reported.
 *
 * Project dimensions carry 0.6 between them and the judge's own four carry
 * 0.4, so a run cannot go green on triage scores while the deterministic gates
 * fail. With the judge off the project dimensions split the whole weight.
 */
function weightsFor(dimensionCount, judgeDimensionCount) {
  const projectShare = judgeDimensionCount > 0 ? 0.6 : 1;
  return {
    project: dimensionCount > 0 ? projectShare / dimensionCount : 0,
    judge: judgeDimensionCount > 0 ? (1 - projectShare) / judgeDimensionCount : 0,
  };
}

/** @param {string} line */
function note(line) {
  process.stderr.write(`${line}\n`);
}

function describeRun(report, args) {
  const offline = report.provider === "mock";
  note(
    `[judge] ${report.outcomes.length} golden cases (${report.counts.tuning} tuning, ${report.counts.held_out} held out) on provider "${report.provider}"`,
  );

  if (!args.withJudge) {
    note("[judge] --no-judge: deterministic dimensions only, no model graded anything.");
    return;
  }

  if (offline) {
    note(
      "[judge] offline: verdicts come from each case's committed `offline.judge` block, not from a model. Deterministic, and evidence of nothing but a working harness.",
    );
    return;
  }

  note(`[judge] grading with JUDGE_MODEL=${resolveJudgeModel()}`);
  if (judgeSharesGeneratorModel()) {
    note(
      "[judge] WARNING: JUDGE_MODEL matches LLM_MODEL, so the model is grading its own output. Self-preference bias is invisible in the score — point JUDGE_MODEL at a different model.",
    );
  }
}

/** The per-case table. Human-readable, stderr, never parsed. */
function renderCases(report, dimensions) {
  for (const outcome of report.outcomes) {
    if (outcome.error) {
      note(`  FAIL ${outcome.id} (${outcome.split}) — generation failed: ${outcome.error}`);
      continue;
    }

    const failed = dimensions.filter(
      (name) => !PROJECT_DIMENSION_SPECS[name].evaluate(outcome).passed,
    );
    const scores = outcome.verdict
      ? ` judge ${JUDGE_DIMENSIONS.map((d) => outcome.verdict[d].score).join("/")}`
      : "";

    note(
      failed.length === 0
        ? `  pass ${outcome.id} (${outcome.split}, ${outcome.format})${scores}`
        : `  FAIL ${outcome.id} (${outcome.split}, ${outcome.format})${scores} — ${failed.join(", ")}`,
    );
  }
}

/** The judge's own four dimensions, summarised over the cases it graded. */
function judgeResults(report, weight) {
  const judged = report.outcomes
    .filter((outcome) => outcome.verdict)
    .map((outcome) => ({ id: outcome.id, verdict: outcome.verdict }));

  if (judged.length === 0) return [];

  return summariseJudgement(judged).map((summary) => toEvalResult(summary, weight, judged.length));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dimensions = selectedDimensions(args);
  if (dimensions.length === 0) {
    throw new Error(
      `--dimension ${args.dimension} needs the judge, so it cannot be combined with --no-judge.`,
    );
  }

  // Only pay for judge calls when something being reported actually needs them.
  const withJudge = args.withJudge && dimensions.some((n) => PROJECT_DIMENSION_SPECS[n].needsJudge);

  const report = await runGoldenSet({
    split: args.split ?? undefined,
    ids: args.ids,
    withJudge,
    onProgress: args.json || args.dimension ? undefined : note,
  });

  describeRun(report, { ...args, withJudge });

  const judgeWeightCount = args.dimension || !withJudge ? 0 : JUDGE_DIMENSIONS.length;
  const weights = weightsFor(dimensions.length, judgeWeightCount);

  const results = dimensions.map((name) => {
    const scored = scoreProjectDimension(name, report);
    return {
      name,
      score: scored.score,
      weight: weights.project,
      passed: scored.score === 1,
      details: scored.details,
    };
  });

  if (judgeWeightCount > 0) results.push(...judgeResults(report, weights.judge));

  if (!args.json && !args.dimension) {
    renderCases(report, dimensions);
    for (const result of results) {
      note(`[judge] ${result.passed ? "PASS" : "FAIL"} ${result.name} (${result.score.toFixed(2)}) — ${result.details}`);
    }
    note(
      `[judge] floor is ${JUDGE_FLOOR}/5 per dimension. Scores gate; they do not rank. A case at ${JUDGE_FLOOR} and a case at 5 count the same.`,
    );
  }

  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
}

try {
  await main();
} catch (error) {
  note(`[judge] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
