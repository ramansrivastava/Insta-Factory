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
 * Phase 1 ships the harness plus two live dimensions:
 *   - schema_validity: the LLM seam produces schema-valid structured output
 *   - smoke_passes:    the primary entry point builds, starts and answers
 *
 * Phases 3-5 add hook_count, hook_distinctiveness, banned_phrases,
 * section_completeness and groundedness as those checks become meaningful.
 *
 * Usage:
 *   node scripts/eval/run.mjs
 *   EVAL_SKIP_SMOKE=1 node scripts/eval/run.mjs   # Layer-1 checks only, no build
 */

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

async function main() {
  const results = [
    await runDimension("schema_validity", 0.5, schemaValidity),
    await runDimension("smoke_passes", 0.5, async () => smokePasses()),
  ];

  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);

  // Non-zero exit when a dimension fails, so the script is usable as a gate on
  // its own as well as through the factory harness.
  process.exitCode = results.every((result) => result.passed) ? 0 : 1;
}

await main();
