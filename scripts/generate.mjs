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
 * `--hooks-only` and `--script-only` run a single half of the pipeline, the
 * same two entry points the Regenerate buttons call. `--script-only` needs the
 * hooks its script will open with, so it takes `--hooks-file`: point it at the
 * `--json` output of a `--hooks-only` run and the two commands compose.
 *
 * Usage:
 *   npm run generate                                  # the sample idea
 *   npm run generate -- --idea "my raw idea"
 *   npm run generate -- --idea "..." --hooks 3
 *   npm run generate -- --idea "..." --json
 *   echo "my raw idea" | npm run generate -- --idea -
 *
 *   npm run --silent generate -- --hooks-only --json > hooks.json
 *   npm run generate -- --hooks-only --hooks-file hooks.json --steer "more casual"
 *   npm run generate -- --script-only --hooks-file hooks.json
 *
 * (`--silent` only to keep npm's own banner out of the redirected JSON.)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `--json` promises a single JSON document on stdout, and pino writes its lines
// there too — so `--hooks-only --json > hooks.json` would produce a file no
// parser accepts. The level is read once when `lib/log.ts` is first imported,
// which is why this has to happen above the imports below rather than in
// `main()`. An explicit LOG_LEVEL still wins: asking for logs and for JSON on
// the same stream is a strange thing to want, but it is the caller's call.
if (process.argv.includes("--json") && !process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "silent";
}

const { generate, regenerateHooks, regenerateScript } = await import(
  path.join(ROOT, "lib/generate/pipeline.ts")
);
const { runLayer1Checks } = await import(path.join(ROOT, "lib/generate/checks.ts"));
const { SAMPLE_IDEA } = await import(path.join(ROOT, "lib/generate/sample.ts"));
const { loadVoiceProfile } = await import(path.join(ROOT, "lib/voice/store.ts"));
const { DEFAULT_HOOK_COUNT, HOOK_ANGLE_LABELS, HookSchema, MAX_HOOKS, MIN_HOOKS } =
  await import(path.join(ROOT, "types/generation.ts"));

/** @param {string[]} argv */
function parseArgs(argv) {
  let idea = null;
  let hookCount = DEFAULT_HOOK_COUNT;
  let json = false;
  let only = null;
  let hooksFile = null;
  let steer = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hooks-only") {
      if (only === "script") throw new Error("--hooks-only and --script-only are alternatives.");
      only = "hooks";
    } else if (arg === "--script-only") {
      if (only === "hooks") throw new Error("--hooks-only and --script-only are alternatives.");
      only = "script";
    } else if (arg === "--hooks-file") {
      hooksFile = argv[i + 1];
      if (hooksFile === undefined) throw new Error("--hooks-file needs a path.");
      i += 1;
    } else if (arg === "--steer") {
      steer = argv[i + 1];
      if (steer === undefined) throw new Error("--steer needs a one-line adjustment.");
      i += 1;
    } else if (arg === "--idea" || arg === "-i") {
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

  if (only === null && (hooksFile !== null || steer !== null)) {
    throw new Error(
      "--hooks-file and --steer only mean something with --hooks-only or --script-only; a full run writes its own hooks and takes no steer.",
    );
  }

  return { idea, hookCount, json, only, hooksFile, steer, help: false };
}

/**
 * Hooks read off disk, for `--script-only` (which they are written against) and
 * for `--hooks-only` (where they become the avoid-context).
 *
 * Accepts either a bare array or any object with a `hooks` field, so the
 * `--json` output of a previous run can be handed straight back without being
 * unwrapped first.
 *
 * @param {string} file
 */
function readHooksFile(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read hooks from ${file}: ${error instanceof Error ? error.message : error}`,
    );
  }

  const candidate = Array.isArray(raw) ? raw : raw?.hooks;
  if (!Array.isArray(candidate)) {
    throw new Error(
      `${file} holds no hooks. Expected a JSON array of hooks, or the output of \`npm run --silent generate -- --hooks-only --json\`.`,
    );
  }

  return candidate.map((hook, index) => {
    const parsed = HookSchema.safeParse(hook);
    if (!parsed.success) {
      throw new Error(`Hook ${index + 1} in ${file} is not a valid hook: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

function readStdin() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    throw new Error("Could not read the idea from stdin.");
  }
}

const USAGE = `npm run generate -- [--idea "..."] [--hooks N] [--json]
                     [--hooks-only | --script-only] [--hooks-file PATH] [--steer "..."]

  --idea, -i      The raw content idea. Pass \`-\` to read it from stdin.
                  Omitted: uses the built-in sample idea the mock fixtures match.
  --hooks, -n     How many hooks to generate (${MIN_HOOKS}-${MAX_HOOKS}, default ${DEFAULT_HOOK_COUNT}).
  --json          Print the raw result as JSON instead of the readable rendering.

  --hooks-only    Run only the hooks call. With --hooks-file, the hooks in that
                  file are handed to the model as "I have seen these, write
                  different ones" — the same avoid-context the Regenerate hooks
                  button sends.
  --script-only   Run only the script call. Requires --hooks-file: a script is
                  written against the hook it opens with.
  --hooks-file    JSON hooks — a bare array, or the --json output of an earlier run.
  --steer         One line of adjustment ("more casual", "lead with the mistake"),
                  appended after the cacheable prefix. Half-runs only.`;

function heading(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

function renderHuman(result, checks, usingSampleIdea, provider) {
  // A half run has one of these and not the other, so each section is printed
  // only when there is something in it — an empty "SCRIPT" heading under
  // --hooks-only would read as a failure rather than as a choice.
  if (result.hooks) {
    heading(`HOOKS (${result.hooks.length})`);
    result.hooks.forEach((hook, index) => {
      console.log(`${index + 1}. [${HOOK_ANGLE_LABELS[hook.angle] ?? hook.angle}] ${hook.text}`);
      console.log(`   why: ${hook.rationale}`);
    });
  }

  if (result.script) {
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

/**
 * One half of the pipeline: `--hooks-only` or `--script-only`.
 *
 * These call `regenerateHooks` / `regenerateScript` — the same functions the
 * Regenerate buttons call, not a CLI-only copy of them. That is the point of
 * having them here: a flag that exercised a different code path would tell you
 * nothing about the one the creator uses.
 */
async function runHalf(args, idea, profile) {
  const known = args.hooksFile === null ? [] : readHooksFile(args.hooksFile);

  if (args.only === "script" && known.length === 0) {
    throw new Error(
      "--script-only needs --hooks-file: a script is written against the hook it opens with. Produce one with `npm run --silent generate -- --hooks-only --json > hooks.json`.",
    );
  }

  if (!args.json) {
    if (args.only === "hooks") {
      console.log(
        known.length === 0
          ? `[generate] hooks only — writing ${args.hookCount} hooks, no script.`
          : `[generate] hooks only — writing ${args.hookCount} hooks away from the ${known.length} in ${args.hooksFile}.`,
      );
    } else {
      console.log(
        `[generate] script only — writing a script against the ${known.length} hook(s) in ${args.hooksFile}.`,
      );
    }
    if (args.steer !== null) console.log(`[generate] steer: ${args.steer}`);
  }

  const result =
    args.only === "hooks"
      ? await regenerateHooks({
          idea,
          profile,
          hookCount: args.hookCount,
          avoid: known,
          steer: args.steer ?? undefined,
        })
      : await regenerateScript({
          idea,
          profile,
          hooks: known,
          steer: args.steer ?? undefined,
        });

  if (args.json) {
    // `hooks` is echoed on a script-only run so the output can be piped back
    // into a later --hooks-file without hand-merging two files.
    process.stdout.write(
      `${JSON.stringify({ idea, ...result, hooks: result.hooks ?? known }, null, 2)}\n`,
    );
    return;
  }

  renderHuman(
    { ...result, hooks: result.hooks ?? known },
    result.checks,
    idea === SAMPLE_IDEA,
    result.meta.provider,
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
  }

  if (args.only !== null) {
    await runHalf(args, idea, loaded.profile);
    return;
  }

  if (!args.json) {
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
