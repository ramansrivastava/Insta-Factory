#!/usr/bin/env node
/**
 * Distil a voice profile from 3-5 pasted captions or scripts.
 *
 * One structured LLM call through the Phase 1 adapter seam. With no
 * ANTHROPIC_API_KEY it runs on the deterministic mock, so the command works
 * offline and in CI.
 *
 * The result is written to a DRAFT file. It is never applied to
 * data/voice-profile.json on its own — a distilled profile is a first draft the
 * creator edits, not an answer.
 *
 * Usage:
 *   npm run voice:distill                     # paste samples on stdin, --- between them
 *   npm run voice:distill -- a.txt b.txt c.txt
 *   npm run voice:distill -- --out data/voice-profile.draft.json
 *
 * Samples on stdin are separated by a line containing only `---`; with no such
 * separator, blank lines are used instead.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = path.join(ROOT, "data", "voice-profile.draft.json");

const { distillVoiceTraits, toDraftProfile, MIN_SAMPLES, MAX_SAMPLES } = await import(
  path.join(ROOT, "lib/voice/distill.ts")
);
const { loadVoiceProfile, saveVoiceProfile, VoiceProfileError } = await import(
  path.join(ROOT, "lib/voice/store.ts")
);

/** @param {string[]} argv */
function parseArgs(argv) {
  let out = DEFAULT_OUT;
  const files = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--out needs a file path.");
      }
      out = path.resolve(ROOT, value);
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag ${arg}.`);
    } else {
      files.push(path.resolve(ROOT, arg));
    }
  }

  return { out, files };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Splits pasted text into samples on `---` lines, falling back to blank lines. */
function splitSamples(text) {
  const bySeparator = text
    .split(/^\s*-{3,}\s*$/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  if (bySeparator.length > 1) return bySeparator;

  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function collectSamples(files) {
  if (files.length > 0) {
    return files.map((file) => readFileSync(file, "utf8").trim()).filter(Boolean);
  }

  if (process.stdin.isTTY) {
    throw new Error(
      `No samples given. Pipe ${MIN_SAMPLES}-${MAX_SAMPLES} captions or scripts on stdin (separated by a line of ---), or pass them as file paths.`,
    );
  }

  return splitSamples(readStdin());
}

async function main() {
  const { out, files } = parseArgs(process.argv.slice(2));
  const samples = collectSamples(files);

  console.log(`[voice:distill] ${samples.length} sample(s) — running one structured call`);

  const { traits, provider, model, usage, latencyMs } = await distillVoiceTraits(samples);

  console.log(
    `[voice:distill] provider=${provider} model=${model} latency=${latencyMs}ms in=${usage.inputTokens} out=${usage.outputTokens}`,
  );

  // Keep any examples the creator has already curated — distillation replaces
  // traits, not the example set.
  let existing;
  try {
    existing = loadVoiceProfile().profile;
  } catch (error) {
    if (!(error instanceof VoiceProfileError) || error.code !== "missing") throw error;
  }

  const draft = toDraftProfile(traits, existing);
  const saved = saveVoiceProfile(draft, { path: out });

  console.log("");
  console.log(`  tone:                ${traits.tone}`);
  console.log(`  sentence_rhythm:     ${traits.sentence_rhythm}`);
  console.log(`  emoji_usage:         ${traits.emoji_usage}`);
  console.log(`  vocabulary_register: ${traits.vocabulary_register}`);
  console.log(`  opener_patterns:     ${traits.opener_patterns.length}`);
  console.log(`  recurring_phrases:   ${traits.recurring_phrases.length}`);
  console.log(`  banned_phrases:      ${traits.banned_phrases.length}`);
  console.log("");

  for (const warning of saved.warnings) {
    console.log(`[voice:distill] warning: ${warning}`);
  }

  console.log(`[voice:distill] draft written to ${path.relative(ROOT, saved.path)}`);
  console.log(
    "[voice:distill] Review and edit it, then copy it over data/voice-profile.json to make it live. Nothing was applied automatically.",
  );
}

try {
  await main();
} catch (error) {
  console.error(`[voice:distill] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
