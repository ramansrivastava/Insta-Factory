import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generate } from "@/lib/generate/pipeline.ts";
import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import {
  appendTraceRecord,
  generationsDir,
  isFeedbackRecord,
  isGenerationRecord,
  profileHash,
  readTraceRecords,
  traceDateStamp,
  traceFilePath,
  tracingEnabled,
  type GenerationRecord,
} from "@/lib/generations/store.ts";
import { VoiceProfileSchema, type VoiceProfile } from "@/types/voice.ts";

/**
 * The generation trace — the file the accept/edit/discard analysis is built on
 * later, and therefore the file whose format has to be right *now*: these
 * records cannot be regenerated after the fact.
 */

const profile: VoiceProfile = VoiceProfileSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "data/voice-profile.example.json"), "utf8"),
  ),
);

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "generations-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("trace file layout", () => {
  it("names the file by UTC date, so the ordering survives a time zone", () => {
    const now = new Date("2026-03-09T23:30:00.000Z");
    expect(traceDateStamp(now)).toBe("2026-03-09");
    expect(path.basename(traceFilePath({ dir: "/tmp/x", now }))).toBe("2026-03-09.jsonl");
  });

  it("resolves the directory explicit-first: dir, then root, then the environment", () => {
    expect(generationsDir({ dir: "/tmp/explicit" })).toBe("/tmp/explicit");
    expect(generationsDir({ root: "/repo" })).toBe(path.join("/repo", "data/generations"));
    expect(generationsDir({ env: { GENERATIONS_DIR: "/var/traces" } })).toBe("/var/traces");
    expect(generationsDir({ root: "/repo", env: { GENERATIONS_DIR: "/var/traces" } })).toBe(
      path.join("/repo", "data/generations"),
    );
  });
});

describe("tracingEnabled", () => {
  it("is off under Vitest, so a test run never writes a day's file", () => {
    expect(tracingEnabled({ VITEST: "true" })).toBe(false);
  });

  it("is on by default outside a test run", () => {
    expect(tracingEnabled({})).toBe(true);
  });

  it("honours an explicit switch either way", () => {
    expect(tracingEnabled({ GENERATION_TRACE: "off", VITEST: "true" })).toBe(false);
    expect(tracingEnabled({ GENERATION_TRACE: "0" })).toBe(false);
    expect(tracingEnabled({ GENERATION_TRACE: "false" })).toBe(false);
    // An explicit "on" beats the Vitest default — that is how the tests below
    // exercise the write path at all.
    expect(tracingEnabled({ GENERATION_TRACE: "on", VITEST: "true" })).toBe(true);
  });
});

describe("profileHash", () => {
  it("is stable across key order, so a re-serialised profile is not a new one", () => {
    const reordered = JSON.parse(
      JSON.stringify({ ...profile, examples: profile.examples, traits: profile.traits }),
    ) as VoiceProfile;
    expect(profileHash(reordered)).toBe(profileHash(profile));
  });

  it("changes when the voice does", () => {
    const edited: VoiceProfile = {
      ...profile,
      traits: { ...profile.traits, banned_phrases: ["game changer"] },
    };
    expect(profileHash(edited)).not.toBe(profileHash(profile));
  });

  it("does not leak the profile's contents", () => {
    expect(profileHash(profile)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("append and read", () => {
  it("round-trips generation and feedback records through one day's file", () => {
    const dir = tempDir();
    const now = new Date("2026-03-09T10:00:00.000Z");

    appendTraceRecord(generationRecord("gen-1"), { dir, now });
    appendTraceRecord(
      {
        type: "feedback",
        generation_id: "gen-1",
        recorded_at: now.toISOString(),
        target: "hook",
        hook_index: 2,
        outcome: "edited",
        edited_text: "What I actually said.",
      },
      { dir, now },
    );

    const { records, files, skippedLines } = readTraceRecords({ dir });
    expect(files).toHaveLength(1);
    expect(skippedLines).toBe(0);
    expect(records.filter(isGenerationRecord)).toHaveLength(1);

    const [feedback] = records.filter(isFeedbackRecord);
    expect(feedback?.outcome).toBe("edited");
    expect(feedback?.hook_index).toBe(2);
  });

  it("skips a half-written line rather than failing the whole read", () => {
    const dir = tempDir();
    const now = new Date("2026-03-09T10:00:00.000Z");
    appendTraceRecord(generationRecord("gen-1"), { dir, now });
    // What a process killed mid-append leaves behind.
    writeFileSync(path.join(dir, "2026-03-09.jsonl"), '{"type":"gener', { flag: "a" });

    const { records, skippedLines } = readTraceRecords({ dir });
    expect(records).toHaveLength(1);
    expect(skippedLines).toBe(1);
  });

  it("reports an empty trace rather than throwing when nothing has run yet", () => {
    const { records, files } = readTraceRecords({ dir: path.join(tempDir(), "absent") });
    expect(records).toEqual([]);
    expect(files).toEqual([]);
  });

  it("reports a failed write instead of throwing over a generation that succeeded", () => {
    // A path whose parent is a file, so mkdir cannot succeed.
    const dir = tempDir();
    const blocker = path.join(dir, "blocked");
    writeFileSync(blocker, "not a directory");

    const outcome = appendTraceRecord(generationRecord("gen-1"), {
      dir: path.join(blocker, "nested"),
    });
    expect(outcome.written).toBe(false);
    expect(outcome.error).toBeDefined();
  });
});

describe("the pipeline's trace record", () => {
  it("writes one record carrying the idea, the profile hash, the output and the checks", async () => {
    const dir = tempDir();
    const result = await generate({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      adapter: new MockAdapter(),
      trace: { enabled: true, dir },
    });

    const { records } = readTraceRecords({ dir });
    expect(records).toHaveLength(1);

    const [record] = records.filter(isGenerationRecord);
    expect(record?.generation_id).toBe(result.meta.generationId);
    expect(record?.idea).toBe(SAMPLE_IDEA);
    expect(record?.hook_count).toBe(5);
    expect(record?.profile_hash).toBe(profileHash(profile));
    expect(record?.hooks).toHaveLength(5);
    // A full generation always records a script; only a hooks-only
    // regeneration leaves this null.
    expect(record?.script).not.toBeNull();
    expect(record?.script?.sections.length).toBeGreaterThan(0);
    expect(record?.parent_generation_id).toBeUndefined();
    expect(record?.regenerated_target).toBeUndefined();
    expect(record?.checks.map((check) => check.name)).toEqual([
      "hook_count",
      "hook_distinctiveness",
      "banned_phrases",
      "section_completeness",
      "groundedness",
    ]);
    expect(record?.checks.every((check) => check.passed)).toBe(true);
    expect(record?.timings.total_ms).toBeGreaterThanOrEqual(0);
    expect(record?.usage.cache_read_input_tokens).toBe(0);
  });

  it("threads the caller's generation id through instead of minting its own", async () => {
    const dir = tempDir();
    const result = await generate({
      idea: SAMPLE_IDEA,
      profile,
      adapter: new MockAdapter(),
      generationId: "trace-me",
      trace: { enabled: true, dir },
    });

    expect(result.meta.generationId).toBe("trace-me");
    const [record] = readTraceRecords({ dir }).records.filter(isGenerationRecord);
    expect(record?.generation_id).toBe("trace-me");
  });

  it("writes nothing when tracing is switched off", async () => {
    const dir = tempDir();
    await generate({
      idea: SAMPLE_IDEA,
      profile,
      adapter: new MockAdapter(),
      trace: { enabled: false, dir },
    });
    expect(readTraceRecords({ dir }).records).toEqual([]);
  });

  it("returns the Layer-1 verdicts alongside the output", async () => {
    const result = await generate({
      idea: SAMPLE_IDEA,
      profile,
      adapter: new MockAdapter(),
      trace: { enabled: false },
    });
    expect(result.checks).toHaveLength(5);
    expect(result.meta.generationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

function generationRecord(id: string): GenerationRecord {
  return {
    type: "generation",
    generation_id: id,
    recorded_at: "2026-03-09T10:00:00.000Z",
    idea: SAMPLE_IDEA,
    hook_count: 5,
    profile_hash: profileHash(profile),
    provider: "mock",
    model: "mock-fixture-model",
    hooks: [],
    script: { sections: [], claims: [] },
    checks: [{ name: "hook_count", passed: true, score: 1, details: "5 hooks" }],
    timings: { total_ms: 12, hooks_ms: 5, script_ms: 7 },
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}
