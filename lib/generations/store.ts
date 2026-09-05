import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { Hook, Script } from "../../types/generation.ts";
import type { FeedbackOutcome, FeedbackTarget } from "../../types/feedback.ts";
import type { VoiceProfile } from "../../types/voice.ts";

/**
 * The generation trace: one append-only JSONL file per day under
 * `data/generations/`.
 *
 * This is Layer 3 of the eval strategy, and it is written from day one for a
 * reason that has nothing to do with today — the accept/edit/discard data is
 * the only reliable long-term ground truth for creative quality, and it is
 * *unrecoverable* if it was not captured at the time. A judge can be re-run
 * over old outputs; what the creator did with those outputs cannot.
 *
 * JSONL rather than a database: the file is appended to, never updated, one
 * process writes it, and the consumers are `npm run generations:summary` and a
 * human with `jq`. A schema migration would cost more than this whole feature.
 *
 * The directory is gitignored — these records contain the creator's own ideas
 * and their voice profile's fingerprint, and they are generated artefacts the
 * repo guard forbids committing.
 */

export const GENERATIONS_DIR = "data/generations";

/** Discriminator, so both record kinds can share one day's file. */
export type TraceRecordType = "generation" | "feedback";

export interface GenerationRecord {
  type: "generation";
  generation_id: string;
  recorded_at: string;
  idea: string;
  hook_count: number;
  /**
   * A fingerprint of the voice profile, not the profile itself. Enough to ask
   * "did quality change when she edited her voice?" without copying her
   * personal data into a second place on disk.
   */
  profile_hash: string;
  provider: string;
  model: string;
  hooks: Hook[];
  script: Script;
  /** Per-check pass/fail from `runLayer1Checks`. */
  checks: { name: string; passed: boolean; score: number; details: string }[];
  timings: { total_ms: number; hooks_ms: number; script_ms: number };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface FeedbackRecord {
  type: "feedback";
  generation_id: string;
  recorded_at: string;
  target: FeedbackTarget;
  /** Zero-based, and present only when `target` is `"hook"`. */
  hook_index?: number;
  outcome: FeedbackOutcome;
  /** The creator's rewrite, when they pasted one back. */
  edited_text?: string;
}

export type TraceRecord = GenerationRecord | FeedbackRecord;

export interface TraceStoreOptions {
  /** Repo root the `data/generations/` directory hangs off. Injected by tests. */
  root?: string;
  /** Explicit directory, overriding `root`. Injected by tests. */
  dir?: string;
  /** Clock, for deterministic tests. */
  now?: Date;
  env?: Record<string, string | undefined>;
}

/**
 * Where the trace lives, most explicit source first: an injected directory, an
 * injected repo root, `GENERATIONS_DIR` from the environment, then the default
 * under the working directory.
 *
 * The environment variable exists because the default is inside the repo, and
 * a deployment that wants these records on a mounted volume should not have to
 * fork the store to get them there.
 */
export function generationsDir(options: TraceStoreOptions = {}): string {
  if (options.dir) return options.dir;
  if (options.root) return path.join(options.root, GENERATIONS_DIR);

  const fromEnv = (options.env ?? process.env).GENERATIONS_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  return path.join(process.cwd(), GENERATIONS_DIR);
}

/** `YYYY-MM-DD` in UTC — a local date would reorder the files when travelling. */
export function traceDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function traceFilePath(options: TraceStoreOptions = {}): string {
  return path.join(generationsDir(options), `${traceDateStamp(options.now)}.jsonl`);
}

/**
 * Tracing is on by default and off under Vitest.
 *
 * Default-on because a trace that has to be enabled is a trace nobody has when
 * they need it. Off under test because the suite runs the real pipeline dozens
 * of times and would otherwise write a day's file full of fixtures — the tests
 * that cover this module point it at a temporary directory instead.
 */
export function tracingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const requested = env.GENERATION_TRACE?.trim().toLowerCase();
  if (requested === "off" || requested === "0" || requested === "false") return false;
  if (requested) return true;
  return !env.VITEST;
}

/** Short, stable fingerprint of a voice profile. Not reversible to the profile. */
export function profileHash(profile: VoiceProfile): string {
  // Sorted keys so two structurally identical profiles hash the same regardless
  // of the order the JSON happened to be written in.
  return createHash("sha256").update(stableStringify(profile)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Appends one record. Never throws: a failed write must not take down a
 * generation that already succeeded — losing a trace line is an annoyance,
 * losing the script the creator waited ten seconds for is the product failing.
 * The caller is handed the error to log instead.
 */
export function appendTraceRecord(
  record: TraceRecord,
  options: TraceStoreOptions = {},
): { written: boolean; file: string; error?: unknown } {
  const file = traceFilePath(options);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    return { written: true, file };
  } catch (error) {
    return { written: false, file, error };
  }
}

/** Every record on disk, oldest file first. Malformed lines are skipped. */
export function readTraceRecords(options: TraceStoreOptions = {}): {
  records: TraceRecord[];
  files: string[];
  skippedLines: number;
} {
  const dir = generationsDir(options);
  const records: TraceRecord[] = [];
  let skippedLines = 0;

  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    // No directory yet means no generations yet, which is a valid answer.
    return { records, files: [], skippedLines };
  }

  const files = names.map((name) => path.join(dir, name));
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as TraceRecord);
      } catch {
        // A half-written final line from a killed process is expected; it must
        // not make the whole summary unreadable.
        skippedLines += 1;
      }
    }
  }

  return { records, files, skippedLines };
}

export function isGenerationRecord(record: TraceRecord): record is GenerationRecord {
  return record.type === "generation";
}

export function isFeedbackRecord(record: TraceRecord): record is FeedbackRecord {
  return record.type === "feedback";
}
