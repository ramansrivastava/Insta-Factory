import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GOLDEN_HELD_OUT_SIZE,
  GOLDEN_SET_SIZE,
  GOLDEN_TUNING_SIZE,
  GoldenSetError,
  goldenCasesDir,
  loadGoldenCases,
  splitCounts,
} from "@/lib/eval/golden.ts";
import { offlineGenerationAdapter, runGoldenSet } from "@/lib/eval/golden-run.ts";
import { PROJECT_DIMENSIONS, scoreProjectDimension } from "@/lib/eval/project-dimensions.ts";
import { GOLDEN_FORMATS, type GoldenCase } from "@/types/golden.ts";
import { VoiceProfileSchema, type VoiceProfile } from "@/types/voice.ts";

const profile: VoiceProfile = VoiceProfileSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "data/voice-profile.example.json"), "utf8"),
  ),
);

const OFFLINE = { LLM_PROVIDER: "mock" } as const;

/** A scratch cases directory, for the malformed-input cases only. */
function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), "golden-"));
}

function writeCase(dir: string, name: string, body: unknown): void {
  writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
}

describe("the committed golden set", () => {
  const cases = loadGoldenCases();

  it("holds exactly twelve cases", () => {
    expect(cases).toHaveLength(GOLDEN_SET_SIZE);
  });

  it("splits eight tuning against four held out", () => {
    expect(splitCounts(cases)).toEqual({
      tuning: GOLDEN_TUNING_SIZE,
      held_out: GOLDEN_HELD_OUT_SIZE,
    });
  });

  it("covers every format, so a regression in one cannot average out", () => {
    for (const format of GOLDEN_FORMATS) {
      expect(cases.filter((item) => item.format === format).length).toBeGreaterThan(0);
    }
  });

  it("holds out at least one case per format", () => {
    const heldOut = cases.filter((item) => item.split === "held_out");
    expect(new Set(heldOut.map((item) => item.format)).size).toBe(GOLDEN_FORMATS.length);
  });

  it("returns cases sorted by id, so reports are diffable", () => {
    expect(cases.map((item) => item.id)).toEqual([...cases.map((item) => item.id)].sort());
  });

  it("gives every case unique ideas and ids", () => {
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(new Set(cases.map((item) => item.idea)).size).toBe(cases.length);
  });

  it("commits an offline block with the requested number of hooks", () => {
    for (const item of cases) {
      expect(item.offline.hooks).toHaveLength(item.hook_count);
    }
  });

  it("filters to one split", () => {
    const heldOut = loadGoldenCases({ split: "held_out" });
    expect(heldOut).toHaveLength(GOLDEN_HELD_OUT_SIZE);
    expect(heldOut.every((item) => item.split === "held_out")).toBe(true);
  });

  it("filters to named ids, in the order given", () => {
    const [first, second] = cases as [GoldenCase, GoldenCase];
    const selected = loadGoldenCases({ ids: [second.id, first.id] });
    expect(selected.map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it("rejects an id that is not in the requested split", () => {
    const tuningId = cases.find((item) => item.split === "tuning")!.id;
    expect(() => loadGoldenCases({ split: "held_out", ids: [tuningId] })).toThrow(GoldenSetError);
  });

  it("resolves its directory under the repo root", () => {
    expect(goldenCasesDir("/repo")).toBe(path.join("/repo", "fixtures", "golden", "cases"));
  });
});

describe("loadGoldenCases rejects a set it cannot trust", () => {
  it("throws rather than returning nothing when the directory is missing", () => {
    expect(() => loadGoldenCases({ dir: path.join(tmpdir(), "no-such-golden-dir") })).toThrow(
      GoldenSetError,
    );
  });

  it("throws on a case that is not valid JSON", () => {
    const dir = scratchDir();
    writeFileSync(path.join(dir, "broken.json"), "{ not json", "utf8");
    expect(() => loadGoldenCases({ dir })).toThrow(/not valid JSON/);
  });

  it("throws on a case that does not match the schema", () => {
    const dir = scratchDir();
    writeCase(dir, "thin.json", { id: "thin", format: "tutorial" });
    expect(() => loadGoldenCases({ dir })).toThrow(/is invalid/);
  });

  // A silently shrinking golden set is the failure this guards: the eval would
  // go green while measuring less than it claims to.
  it("throws when a case's filename does not match its id", () => {
    const dir = scratchDir();
    const original = loadGoldenCases()[0];
    writeCase(dir, "renamed.json", original);
    expect(() => loadGoldenCases({ dir })).toThrow(/must be named/);
  });
});

describe("running the golden set offline", () => {
  it("runs every case through the real pipeline and grades it", async () => {
    const report = await runGoldenSet({ env: OFFLINE, profile, withJudge: true });

    expect(report.provider).toBe("mock");
    expect(report.withJudge).toBe(true);
    expect(report.outcomes).toHaveLength(GOLDEN_SET_SIZE);
    expect(report.counts).toEqual({
      tuning: GOLDEN_TUNING_SIZE,
      held_out: GOLDEN_HELD_OUT_SIZE,
    });

    for (const outcome of report.outcomes) {
      expect(outcome.error).toBeUndefined();
      expect(outcome.hooks).toHaveLength(outcome.hookCount);
      expect(outcome.checks.length).toBeGreaterThan(0);
      expect(outcome.verdict).toBeDefined();
    }
  });

  it("leaves verdicts off when the judge is not asked for", async () => {
    const report = await runGoldenSet({
      env: OFFLINE,
      profile,
      ids: [loadGoldenCases()[0]!.id],
    });

    expect(report.withJudge).toBe(false);
    expect(report.outcomes[0]!.verdict).toBeUndefined();
  });

  it("gives each case its own fixtures rather than one shared generation", async () => {
    const [first, second] = loadGoldenCases() as [GoldenCase, GoldenCase];
    const firstAdapter = offlineGenerationAdapter(first);
    const secondAdapter = offlineGenerationAdapter(second);
    expect(firstAdapter).not.toBe(secondAdapter);

    const report = await runGoldenSet({
      env: OFFLINE,
      profile,
      ids: [first.id, second.id],
    });

    expect(report.outcomes[0]!.hooks[0]!.text).not.toBe(report.outcomes[1]!.hooks[0]!.text);
  });

  it("passes every project dimension on the committed set", async () => {
    const report = await runGoldenSet({ env: OFFLINE, profile, withJudge: true });

    for (const dimension of PROJECT_DIMENSIONS) {
      const scored = scoreProjectDimension(dimension, report);
      expect(scored.score, `${dimension}: ${scored.details}`).toBe(1);
      expect(scored.details).toContain(`${GOLDEN_SET_SIZE}/${GOLDEN_SET_SIZE}`);
    }
  });

  // The judge is opt-in and the pipeline is not, so a case can arrive with
  // checks but no verdict. `voice_match` must fail rather than pass on its
  // deterministic half alone.
  it("fails voice_match when the judge did not run", async () => {
    const report = await runGoldenSet({ env: OFFLINE, profile, withJudge: false });
    const scored = scoreProjectDimension("voice_match", report);

    expect(scored.score).toBe(0);
    expect(scored.details).toContain("no judge verdict");
  });
});
