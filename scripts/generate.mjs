#!/usr/bin/env node
/**
 * Run the core loop from the command line: raw idea in, hooks plus a full
 * script out.
 *
 * This exists so the product is exercisable before any UI does. It is the same
 * pipeline the API route and the eval call — not a parallel implementation.
 *
 * With no ANTHROPIC_API_KEY it runs on the deterministic mock adapter, which
 * answers from `fixtures/llm/` regardless of the idea you pass. That is why the
 * default idea is the one the fixtures were written against: with a different
 * idea on the mock, the groundedness check below is comparing a fixture to
 * something it has never seen, and will (correctly) report violations.
 *
 * Usage:
 *   npm run generate                                  # the sample idea
 *   npm run generate -- --idea "my raw idea"
 *   npm run generate -- --idea "..." --hooks 3
 *   npm run generate -- --idea "..." --json
 *   echo "my raw idea" | npm run generate -- --idea -
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { generate } = await import(path.join(ROOT, "lib/generate/pipeline.ts"));
const { runLayer1Checks } = await import(path.join(ROOT, "lib/generate/checks.ts"));
const { SAMPLE_IDEA } = await import(path.join(ROOT, "lib/generate/sample.ts"));
const { loadVoiceProfile } = await import(path.join(ROOT, "lib/voice/store.ts"));
const { DEFAULT_HOOK_COUNT, HOOK_ANGLE_LABELS, MAX_HOOKS, MIN_HOOKS } = await import(
  path.join(ROOT, "types/generation.ts")
);

/** @param {string[]} argv */
function parseArgs(argv) {
  let idea = null;
  let hookCount = DEFAULT_HOOK_COUNT;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--idea" || arg === "-i") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--idea needs a value (or `-` to read stdin).");
      idea = value === "-" ? readStdin() : value;
      i += 1;
    } else if (arg === "--hooks" || arg === "-n") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--hooks needs a number.");
      hookCount = Number(value);
      if (!Number.isInteger(hookCount) || hookCount < MIN_HOOKS || hookCount > MAX_HOOKS) {
        throw new Error(
          `--hooks must be a whole number between ${MIN_HOOKS} and ${MAX_HOOKS} (every hook takes a different angle, and there are only ${MAX_HOOKS} angles).`,
        );
      }
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument ${arg}. Try --help.`);
    }
  }

  return { idea, hookCount, json, help: false };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    throw new Error("Could not read the idea from stdin.");
  }
}

const USAGE = `npm run generate -- [--idea "..."] [--hooks N] [--json]

  --idea, -i   The raw content idea. Pass \`-\` to read it from stdin.
               Omitted: uses the built-in sample idea the mock fixtures match.
  --hooks, -n  How many hooks to generate (${MIN_HOOKS}-${MAX_HOOKS}, default ${DEFAULT_HOOK_COUNT}).
  --json       Print the raw result as JSON instead of the readable rendering.`;

function heading(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

function renderHuman(result, checks, usingSampleIdea, provider) {
  heading(`HOOKS (${result.hooks.length})`);
  result.hooks.forEach((hook, index) => {
    console.log(`${index + 1}. [${HOOK_ANGLE_LABELS[hook.angle] ?? hook.angle}] ${hook.text}`);
    console.log(`   why: ${hook.rationale}`);
  });

  heading("SCRIPT");
  for (const section of result.script.sections) {
    console.log(`[${section.kind.toUpperCase()}] ${section.text}`);
    if (section.on_screen_text) {
      console.log(`   on screen: ${section.on_screen_text}`);
    }
    console.log("");
  }

  if (result.script.claims.length > 0) {
    heading("CLAIMS");
    for (const claim of result.script.claims) {
      console.log(`- ${claim.text}`);
      console.log(`  grounded in: "${claim.grounded_in}"`);
    }
  }

  heading("LAYER-1 CHECKS");
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.name}: ${check.details}`);
  }

  if (provider === "mock" && !usingSampleIdea) {
    console.log("");
    console.log(
      "[generate] note: provider=mock answers from fixtures/llm/ regardless of your idea, so any groundedness failure above is comparing the fixture against an idea it was not written for. Set ANTHROPIC_API_KEY for real output.",
    );
  }

  console.log("");
  console.log(
    `[generate] provider=${result.meta.provider} model=${result.meta.model} latency=${result.meta.latencyMs}ms cache_read=${result.meta.cacheReadTokens}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const usingSampleIdea = args.idea === null;
  const idea = usingSampleIdea ? SAMPLE_IDEA : args.idea;

  // A fresh checkout has no data/voice-profile.json (it is gitignored personal
  // data), so fall back to the committed example rather than failing — the
  // README promises a generated output in under five minutes.
  const loaded = loadVoiceProfile({ fallbackToExample: true });

  if (!args.json) {
    if (usingSampleIdea) {
      console.log("[generate] no --idea given — using the built-in sample idea:");
      console.log(`[generate]   ${idea}`);
    }
    if (loaded.usedExample) {
      console.log(
        "[generate] no data/voice-profile.json — using data/voice-profile.example.json. Run `npm run voice:distill` to build your own.",
      );
    }
    for (const warning of loaded.warnings) {
      console.log(`[generate] warning: ${warning}`);
    }
    console.log(`[generate] generating ${args.hookCount} hooks, then the script ...`);
  }

  const result = await generate({
    idea,
    profile: loaded.profile,
    hookCount: args.hookCount,
  });

  const checks = runLayer1Checks({
    idea,
    hooks: result.hooks,
    script: result.script,
    hookCount: args.hookCount,
    bannedPhrases: loaded.profile.traits.banned_phrases,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ idea, ...result, checks }, null, 2)}\n`);
    return;
  }

  renderHuman(result, checks, usingSampleIdea, result.meta.provider);
}

try {
  await main();
} catch (error) {
  console.error(`[generate] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
