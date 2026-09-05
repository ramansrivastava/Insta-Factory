import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { GoldenCaseSchema, type GoldenCase, type GoldenSplit } from "../../types/golden.ts";

/**
 * Loads the golden set from `fixtures/golden/cases/`.
 *
 * One file per case rather than one manifest: a twelve-entry array is a file
 * every change touches, and a diff that moves one case's idea should not be a
 * diff that could have moved all twelve.
 */

/** Twelve cases, eight for tuning and four held out. Asserted by the tests. */
export const GOLDEN_SET_SIZE = 12;
export const GOLDEN_TUNING_SIZE = 8;
export const GOLDEN_HELD_OUT_SIZE = 4;

export class GoldenSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenSetError";
  }
}

export function goldenCasesDir(root: string = process.cwd()): string {
  return path.join(root, "fixtures", "golden", "cases");
}

export interface LoadGoldenOptions {
  root?: string;
  dir?: string;
  /** `"tuning"` or `"held_out"`; omit for the whole set. */
  split?: GoldenSplit;
  /** Restrict to specific case ids, in the order given. */
  ids?: readonly string[];
}

/**
 * Every case, sorted by id so a run's report is stable and diffable.
 *
 * Validation failures throw rather than skipping the file. A golden set that
 * silently shrinks because one case stopped parsing is worse than no golden set
 * — the eval would go green while measuring less.
 */
export function loadGoldenCases(options: LoadGoldenOptions = {}): GoldenCase[] {
  const dir = options.dir ?? goldenCasesDir(options.root);

  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    throw new GoldenSetError(
      `Could not read the golden set at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const cases = files.sort().map((file) => parseCase(path.join(dir, file)));

  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) {
      throw new GoldenSetError(`Duplicate golden case id "${item.id}" in ${dir}.`);
    }
    seen.add(item.id);
  }

  cases.sort((a, b) => a.id.localeCompare(b.id));

  let selected = cases;
  if (options.split) {
    selected = selected.filter((item) => item.split === options.split);
  }
  if (options.ids && options.ids.length > 0) {
    const byId = new Map(selected.map((item) => [item.id, item]));
    selected = options.ids.map((id) => {
      const found = byId.get(id);
      if (!found) {
        throw new GoldenSetError(
          `No golden case with id "${id}"${options.split ? ` in the ${options.split} split` : ""}.`,
        );
      }
      return found;
    });
  }

  return selected;
}

function parseCase(file: string): GoldenCase {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new GoldenSetError(
      `Golden case ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = GoldenCaseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoldenSetError(`Golden case ${file} is invalid: ${parsed.error.message}`);
  }

  const expected = `${parsed.data.id}.json`;
  if (path.basename(file) !== expected) {
    throw new GoldenSetError(
      `Golden case ${file} declares id "${parsed.data.id}", so its file must be named ${expected}.`,
    );
  }

  return parsed.data;
}

/** Case counts per split, for the report header. */
export function splitCounts(cases: readonly GoldenCase[]): Record<GoldenSplit, number> {
  return {
    tuning: cases.filter((item) => item.split === "tuning").length,
    held_out: cases.filter((item) => item.split === "held_out").length,
  };
}
