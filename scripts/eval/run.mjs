#!/usr/bin/env node
/**
 * Layer 1 of the eval strategy: fast, deterministic, zero-network checks.
 *
 * Emits a single JSON object on stdout:
 *
 *   {"results":[{"name":..., "score":..., "weight":..., "passed":..., "details":...}]}
 *
 * matching the shape the factory's `eval/score.py` harness consumes. Human-
 * readable progress goes to stderr so stdout stays machine-parseable.
 *
 * Seven live dimensions:
 *   - schema_validity:      the LLM seam produces schema-valid structured output
 *   - smoke_passes:         the primary entry point builds, starts and answers
 *   - hook_count:           the core loop returns exactly the hooks asked for
 *   - hook_distinctiveness: every hook takes a different angle
 *   - banned_phrases:       nothing the creator has banned appears in the output
 *   - section_completeness: the script has a hook, a body and a CTA
 *   - groundedness:         no number, name or claim the idea does not support
 *
 * The five product dimensions all come from a single run of the real pipeline
 * (`lib/generate/pipeline.ts`) — the same code path the CLI and the API route
 * use, on the deterministic mock adapter. They are gates, not scores: each is 1
 * or 0. Judging whether the writing is any *good* is Layer 2's job (Phase 7),
 * and the only ground truth for that is Layer 3's accept/edit/discard data.
 *
 * `--with-judge` adds Layer 2 on top: the twelve-case golden set from
 * `fixtures/golden/`, each generation graded by `scripts/eval/judge.mjs`'s
 * rubric judge. It is off by default because it is the slow, and with an API
 * key the expensive, half — the default run stays a fast local gate. When it
 * is on, the Layer-1 dimensions keep half the total weight and the golden-set
 * dimensions take the other half.
 *
 * Usage:
 *   node scripts/eval/run.mjs
 *   node scripts/eval/run.mjs --with-judge         # + the golden set and the judge
 *   EVAL_SKIP_SMOKE=1 node scripts/eval/run.mjs   # Layer-1 checks only, no build
 */

// Set before anything imports `lib/log.ts`: the pipeline emits a JSON log line
// per phase on stdout, and stdout here must parse as a single object. An
// operator who asked for logs explicitly still gets them.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "silent";

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @typedef {{name: string, score: number, weight: number, passed: boolean, details: string}} Result */

/**
 * @param {string} name
 * @param {number} weight
 * @param {() => Promise<{passed: boolean, details: string, score?: number}>} check
 * @returns {Promise<Result>}
 */
async function runDimension(name, weight, check) {
  process.stderr.write(`[eval] ${name} ...\n`);
  try {
    const outcome = await check();
    const score = outcome.score ?? (outcome.passed ? 1 : 0);
    process.stderr.write(
      `[eval] ${name}: ${outcome.passed ? "PASS" : "FAIL"} (${score}) — ${outcome.details}\n`,
    );
    return { name, score, weight, passed: outcome.passed, details: outcome.details };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[eval] ${name}: ERROR — ${details}\n`);
    return { name, score: 0, weight, passed: false, details: `errored: ${details}` };
  }
}

/**
 * Drives a structured request end to end through the configured adapter and
 * checks the payload against its Zod schema. With no ANTHROPIC_API_KEY this
 * runs on the deterministic mock, so the dimension is meaningful offline.
 */
async function schemaValidity() {
  const { getAdapter } = await import(path.join(ROOT, "lib/llm/index.ts"));
  const { buildProbeRequest, ProbeSchema } = await import(
    path.join(ROOT, "lib/llm/probe.ts")
  );

  const adapter = getAdapter();
  const result = await adapter.generateStructured(buildProbeRequest());
  const parsed = ProbeSchema.safeParse(result.data);

  if (!parsed.success) {
    return {
      passed: false,
      details: `adapter "${adapter.provider}" returned a payload that failed schema validation: ${parsed.error.message}`,
    };
  }

  return {
    passed: true,
    details: `adapter "${adapter.provider}" (model ${result.model}) returned a schema-valid payload with ${parsed.data.items.length} items`,
  };
}

/** Runs the project's own smoke test — build, start, hit /api/health. */
function smokePasses() {
  if (process.env.EVAL_SKIP_SMOKE === "1") {
    return {
      passed: false,
      score: 0,
      details: "skipped: EVAL_SKIP_SMOKE=1 (not counted as a pass)",
    };
  }

  const proc = spawnSync("bash", ["scripts/smoke.sh"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LLM_PROVIDER: process.env.LLM_PROVIDER ?? "mock" },
  });

  if (proc.status === 0) {
    return { passed: true, details: "scripts/smoke.sh exited 0" };
  }

  const tail = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim().split("\n").slice(-5).join(" | ");
  return {
    passed: false,
    details: `scripts/smoke.sh exited ${proc.status ?? "null"}: ${tail || "no output"}`,
  };
}

/**
 * Runs the core loop once and returns its five deterministic checks, keyed by
 * name.
 *
 * One generation feeds all five dimensions — running the pipeline five times
 * would be five times the latency for identical output. On the mock adapter
 * the answer comes from `fixtures/llm/`, which is why `SAMPLE_IDEA` is the idea
 * used here: the fixtures are written to be grounded in exactly those words.
 */
async function runCoreLoop() {
  const { generate } = await import(path.join(ROOT, "lib/generate/pipeline.ts"));
  const { runLayer1Checks } = await import(path.join(ROOT, "lib/generate/checks.ts"));
  const { SAMPLE_IDEA } = await import(path.join(ROOT, "lib/generate/sample.ts"));
  const { loadVoiceProfile } = await import(path.join(ROOT, "lib/voice/store.ts"));
  const { DEFAULT_HOOK_COUNT } = await import(path.join(ROOT, "types/generation.ts"));

  const { profile } = loadVoiceProfile({ fallbackToExample: true });
  const hookCount = DEFAULT_HOOK_COUNT;

  const result = await generate({ idea: SAMPLE_IDEA, profile, hookCount });
  const checks = runLayer1Checks({
    idea: SAMPLE_IDEA,
    hooks: result.hooks,
    script: result.script,
    hookCount,
    bannedPhrases: profile.traits.banned_phrases,
  });

  return new Map(checks.map((check) => [check.name, check]));
}

/**
 * Turns one already-computed check into a dimension. The generation is shared,
 * so a failure to generate at all fails every product dimension rather than
 * silently passing four of them.
 * @param {Map<string, {passed: boolean, score: number, details: string}> | Error} loop
 * @param {string} name
 */
function fromCoreLoop(loop, name) {
  if (loop instanceof Error) {
    return { passed: false, details: `generation failed: ${loop.message}` };
  }
  const check = loop.get(name);
  if (!check) {
    return { passed: false, details: `no check named "${name}" was produced` };
  }
  return { passed: check.passed, score: check.score, details: check.details };
}

/**
 * Layer 2: the golden set, and the judge over it.
 *
 * Returns the four project dimensions `factory.md` binds, plus the judge's own
 * four. Everything here is a floor pass rate — see `lib/eval/judge.ts` for why
 * a judge mean is never what gets scored.
 * @param {number} projectWeight total weight to split across the project dimensions
 * @param {number} judgeWeight   total weight to split across the judge dimensions
 */
async function goldenDimensions(projectWeight, judgeWeight) {
  const { runGoldenSet } = await import(path.join(ROOT, "lib/eval/golden-run.ts"));
  const { PROJECT_DIMENSIONS, scoreProjectDimension } = await import(
    path.join(ROOT, "lib/eval/project-dimensions.ts"),
  );
  const { summariseJudgement, toEvalResult, judgeSharesGeneratorModel } = await import(
    path.join(ROOT, "lib/eval/judge.ts")
  );
  const { JUDGE_DIMENSIONS } = await import(path.join(ROOT, "types/judge.ts"));

  if (judgeSharesGeneratorModel()) {
    process.stderr.write(
      "[eval] WARNING: JUDGE_MODEL matches LLM_MODEL — the model is grading its own output. Self-preference bias does not show up in the score.\n",
    );
  }

  const report = await runGoldenSet({
    withJudge: true,
    onProgress: (line) => process.stderr.write(`[eval] ${line}\n`),
  });

  /** @type {Result[]} */
  const results = PROJECT_DIMENSIONS.map((name) => {
    const scored = scoreProjectDimension(name, report);
    const passed = scored.score === 1;
    process.stderr.write(
      `[eval] golden_${name}: ${passed ? "PASS" : "FAIL"} (${scored.score.toFixed(2)}) — ${scored.details}\n`,
    );
    // Prefixed: `hook_distinctiveness` already exists above as a single
    // generation's Layer-1 gate, and two rows with one name in the same results
    // array is a report nobody can read.
    return {
      name: `golden_${name}`,
      score: scored.score,
      weight: projectWeight / PROJECT_DIMENSIONS.length,
      passed,
      details: scored.details,
    };
  });

  const judged = report.outcomes
    .filter((outcome) => outcome.verdict)
    .map((outcome) => ({ id: outcome.id, verdict: outcome.verdict }));

  for (const summary of summariseJudgement(judged)) {
    const result = toEvalResult(summary, judgeWeight / JUDGE_DIMENSIONS.length, judged.length);
    process.stderr.write(
      `[eval] ${result.name}: ${result.passed ? "PASS" : "FAIL"} (${result.score.toFixed(2)}) — ${result.details}\n`,
    );
    results.push(result);
  }

  return results;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { withJudge: false };
  for (const arg of argv) {
    if (arg === "--with-judge") {
      args.withJudge = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument ${arg}. Try --help.`);
    }
  }
  return args;
}

const USAGE = `node scripts/eval/run.mjs [--with-judge]

  --with-judge   Also run the twelve-case golden set and the rubric judge
                 (Layer 2). Slower, and not free with an API key. Layer 1
                 keeps half the weight; the golden set takes the other half.
  EVAL_SKIP_SMOKE=1 in the environment skips the build/start smoke dimension.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // With the judge on, Layer 1 is halved so the golden set carries real weight
  // rather than being a rounding error on top of seven existing dimensions.
  const layer1 = args.withJudge ? 0.5 : 1;

  process.stderr.write("[eval] running the core loop once for the product dimensions ...\n");
  /** @type {Map<string, {passed: boolean, score: number, details: string}> | Error} */
  let loop;
  try {
    loop = await runCoreLoop();
  } catch (error) {
    loop = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(`[eval] core loop errored: ${loop.message}\n`);
  }

  const results = [
    await runDimension("schema_validity", 0.15 * layer1, schemaValidity),
    await runDimension("smoke_passes", 0.15 * layer1, async () => smokePasses()),
    await runDimension("hook_count", 0.1 * layer1, async () => fromCoreLoop(loop, "hook_count")),
    await runDimension("hook_distinctiveness", 0.15 * layer1, async () =>
      fromCoreLoop(loop, "hook_distinctiveness"),
    ),
    await runDimension("banned_phrases", 0.15 * layer1, async () =>
      fromCoreLoop(loop, "banned_phrases"),
    ),
    await runDimension("section_completeness", 0.15 * layer1, async () =>
      fromCoreLoop(loop, "section_completeness"),
    ),
    await runDimension("groundedness", 0.15 * layer1, async () =>
      fromCoreLoop(loop, "groundedness"),
    ),
  ];

  if (args.withJudge) {
    process.stderr.write("[eval] layer 2: the golden set, graded ...\n");
    try {
      // 0.3 to the four project dimensions, 0.2 to the judge's own four: the
      // dimensions the factory scores on outweigh the triage signal behind them.
      results.push(...(await goldenDimensions(0.3, 0.2)));
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[eval] golden set errored: ${details}\n`);
      results.push({
        name: "golden_set",
        score: 0,
        weight: 0.5,
        passed: false,
        details: `the golden set could not be run: ${details}`,
      });
    }
  }

  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);

  // Non-zero exit when a dimension fails, so the script is usable as a gate on
  // its own as well as through the factory harness.
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
}

await main();
