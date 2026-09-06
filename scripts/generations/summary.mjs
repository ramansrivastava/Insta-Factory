#!/usr/bin/env node
/**
 * `npm run generations:summary` — what the generation trace says so far.
 *
 * Three questions, all of which are invisible without this:
 *
 *   1. **Is prompt caching still working?** `cache_read_input_tokens` going to
 *      zero is the *only* signal that something per-request has leaked into the
 *      cacheable prefix. There is no error, no warning, and no change in the
 *      output — just a bill that quietly doubles. So the mean is printed per
 *      generation, and the count of zero-cache-read runs is printed beside it.
 *
 *   2. **Is the writing any good?** Accept/edit/discard is Layer 3 of the eval
 *      strategy and the only ground truth this product will ever have for that.
 *      Rates are reported for hooks and for scripts separately, because they
 *      are different products with different failure modes.
 *
 *   3. **How often was one pass not enough?** A regeneration is a creator
 *      saying "not this" with a button instead of a rating, and it is counted
 *      here as its own signal. It is not redundant with accept/edit/discard:
 *      those describe the output that was finally kept, and say nothing about
 *      how many attempts it took to get there.
 *
 * Reads `data/generations/*.jsonl` and writes a human-readable report to
 * stdout. `--json` emits the same numbers as one object, for anything that
 * wants to chart them.
 *
 * Usage:
 *   npm run generations:summary
 *   npm run generations:summary -- --json
 *   npm run generations:summary -- --dir /path/to/generations
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const {
  readTraceRecords,
  isGenerationRecord,
  isFeedbackRecord,
  isRegenerationRecord,
  GENERATIONS_DIR,
} = await import(path.join(ROOT, "lib/generations/store.ts"));
const { FEEDBACK_OUTCOMES, FEEDBACK_OUTCOME_LABELS } = await import(
  path.join(ROOT, "types/feedback.ts")
);

/** @param {string[]} argv */
function parseArgs(argv) {
  let json = false;
  let dir = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--dir") {
      dir = argv[i + 1];
      if (dir === undefined) throw new Error("--dir needs a path.");
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument ${arg}. Try --help.`);
    }
  }

  return { json, dir, help: false };
}

/**
 * The key a piece of feedback is about. One rating per key survives — the last
 * one written — because changing your mind about a hook is a correction, not a
 * second data point.
 *
 * @param {{target: string, hook_index?: number}} record
 */
function subjectKey(record) {
  return record.target === "hook" ? `hook:${record.hook_index}` : "script";
}

function summarise(records) {
  const generations = records.filter(isGenerationRecord);
  const feedback = records.filter(isFeedbackRecord);

  /** @type {Map<string, {target: string, outcome: string}>} */
  const latest = new Map();
  const knownGenerations = new Set(generations.map((record) => record.generation_id));
  let orphaned = 0;

  for (const record of feedback) {
    if (!knownGenerations.has(record.generation_id)) orphaned += 1;
    latest.set(`${record.generation_id}|${subjectKey(record)}`, {
      target: record.target,
      outcome: record.outcome,
    });
  }

  const counts = { all: blankCounts(), hook: blankCounts(), script: blankCounts() };
  for (const entry of latest.values()) {
    counts.all[entry.outcome] += 1;
    counts[entry.target][entry.outcome] += 1;
  }

  // A regeneration names its parent; a first-pass run does not. Split rather
  // than lumped, because a rate is only meaningful against the number of ideas
  // that were actually attempted once.
  const regenerations = generations.filter(isRegenerationRecord);
  const firstPass = generations.filter((record) => !isRegenerationRecord(record));
  const regeneratedParents = new Set(
    regenerations.map((record) => record.parent_generation_id),
  );
  const regenerationsByTarget = { hooks: 0, script: 0 };
  for (const record of regenerations) {
    if (record.regenerated_target in regenerationsByTarget) {
      regenerationsByTarget[record.regenerated_target] += 1;
    }
  }
  const steered = regenerations.filter((record) => record.steer !== undefined).length;

  const cacheReads = generations.map((record) => record.usage.cache_read_input_tokens);
  const totalLatency = generations.reduce((sum, record) => sum + record.timings.total_ms, 0);
  const checkFailures = new Map();
  let cleanGenerations = 0;

  for (const record of generations) {
    let failed = false;
    for (const check of record.checks ?? []) {
      if (check.passed) continue;
      failed = true;
      checkFailures.set(check.name, (checkFailures.get(check.name) ?? 0) + 1);
    }
    if (!failed) cleanGenerations += 1;
  }

  return {
    generations: generations.length,
    firstPassGenerations: firstPass.length,
    regenerations: regenerations.length,
    regenerationsByTarget,
    /** Distinct runs that were regenerated at least once. */
    regeneratedGenerations: regeneratedParents.size,
    steeredRegenerations: steered,
    days: new Set(generations.map((record) => record.recorded_at.slice(0, 10))).size,
    providers: [...new Set(generations.map((record) => `${record.provider}/${record.model}`))],
    meanCacheReadInputTokens: mean(cacheReads),
    zeroCacheReadGenerations: cacheReads.filter((value) => value === 0).length,
    meanLatencyMs: generations.length ? Math.round(totalLatency / generations.length) : 0,
    cleanGenerations,
    checkFailures: Object.fromEntries([...checkFailures.entries()].sort()),
    ratedSubjects: latest.size,
    orphanedFeedback: orphaned,
    outcomes: {
      all: withRates(counts.all),
      hook: withRates(counts.hook),
      script: withRates(counts.script),
    },
  };
}

function blankCounts() {
  return Object.fromEntries(FEEDBACK_OUTCOMES.map((outcome) => [outcome, 0]));
}

function withRates(counts) {
  const total = FEEDBACK_OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0);
  return {
    total,
    counts,
    rates: Object.fromEntries(
      FEEDBACK_OUTCOMES.map((outcome) => [
        outcome,
        total === 0 ? null : counts[outcome] / total,
      ]),
    ),
  };
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatRate(rate) {
  return rate === null ? "  n/a" : `${(rate * 100).toFixed(1).padStart(5)}%`;
}

function report(summary, files, skippedLines) {
  const lines = [];
  lines.push("Generation trace summary");
  lines.push("========================");
  lines.push(`files            ${files.length} (${GENERATIONS_DIR}/)`);
  lines.push(`generations      ${summary.generations} across ${summary.days} day(s)`);
  if (summary.generations === 0) {
    lines.push("");
    lines.push("No generations recorded yet. Run `npm run generate` or use the app,");
    lines.push("then run this again.");
    return lines.join("\n");
  }

  lines.push(`providers        ${summary.providers.join(", ")}`);
  lines.push(`mean latency     ${summary.meanLatencyMs}ms`);
  lines.push("");
  lines.push("Prompt cache");
  lines.push("------------");
  lines.push(
    `mean cache_read_input_tokens per generation   ${summary.meanCacheReadInputTokens.toFixed(1)}`,
  );
  lines.push(
    `generations that read nothing from cache      ${summary.zeroCacheReadGenerations}/${summary.generations}`,
  );
  if (summary.zeroCacheReadGenerations === summary.generations) {
    lines.push(
      "  ! every generation read zero cached tokens. On a real provider that means",
    );
    lines.push(
      "    the cacheable prefix is varying per request — check lib/prompts/system.ts.",
    );
  }

  lines.push("");
  lines.push("Regeneration");
  lines.push("------------");
  lines.push(
    `first-pass runs                  ${summary.firstPassGenerations}`,
  );
  lines.push(
    `regenerations                    ${summary.regenerations} (${summary.regenerationsByTarget.hooks} hooks, ${summary.regenerationsByTarget.script} script)`,
  );
  lines.push(
    `runs regenerated at least once   ${summary.regeneratedGenerations}/${summary.firstPassGenerations}`,
  );
  lines.push(`regenerations with a steer       ${summary.steeredRegenerations}`);
  if (summary.regenerations === 0) {
    lines.push(
      "  every run was accepted on the first pass, or nobody has pressed the button yet.",
    );
  }

  lines.push("");
  lines.push("Layer-1 checks");
  lines.push("--------------");
  lines.push(
    `generations passing every check   ${summary.cleanGenerations}/${summary.generations}`,
  );
  for (const [name, count] of Object.entries(summary.checkFailures)) {
    lines.push(`  ${name.padEnd(22)} failed ${count}x`);
  }

  lines.push("");
  lines.push("Accept / edit / discard");
  lines.push("-----------------------");
  lines.push(`rated items      ${summary.ratedSubjects}`);
  if (summary.orphanedFeedback > 0) {
    lines.push(
      `  ! ${summary.orphanedFeedback} feedback line(s) reference a generation not in the trace`,
    );
  }
  lines.push("");
  lines.push(`${"".padEnd(14)}${"all".padStart(8)}${"hooks".padStart(9)}${"scripts".padStart(10)}`);
  for (const outcome of FEEDBACK_OUTCOMES) {
    lines.push(
      [
        FEEDBACK_OUTCOME_LABELS[outcome].padEnd(14),
        formatRate(summary.outcomes.all.rates[outcome]).padStart(8),
        formatRate(summary.outcomes.hook.rates[outcome]).padStart(9),
        formatRate(summary.outcomes.script.rates[outcome]).padStart(10),
      ].join(""),
    );
  }
  lines.push(
    [
      "n".padEnd(14),
      String(summary.outcomes.all.total).padStart(8),
      String(summary.outcomes.hook.total).padStart(9),
      String(summary.outcomes.script.total).padStart(10),
    ].join(""),
  );

  if (summary.ratedSubjects === 0) {
    lines.push("");
    lines.push("Nothing rated yet. The buttons under each hook and the script write here.");
  }
  if (skippedLines > 0) {
    lines.push("");
    lines.push(`note: skipped ${skippedLines} unparseable line(s).`);
  }

  return lines.join("\n");
}

const HELP = `npm run generations:summary — accept/edit/discard rates and prompt-cache health

  --json          emit the summary as one JSON object
  --dir <path>    read a directory other than ${GENERATIONS_DIR}/
  --help          this text
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const options = args.dir ? { dir: path.resolve(args.dir) } : { root: ROOT };
  const { records, files, skippedLines } = readTraceRecords(options);
  const summary = summarise(records);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ files, skippedLines, ...summary }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${report(summary, files, skippedLines)}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
