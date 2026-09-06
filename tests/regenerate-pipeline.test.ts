import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import type { LlmAdapter, StructuredRequest, StructuredResult } from "@/lib/llm/types.ts";
import {
  GenerationInputError,
  generate,
  normalizeSteer,
  regenerateHooks,
  regenerateScript,
} from "@/lib/generate/pipeline.ts";
import { runHookChecks, runScriptChecks } from "@/lib/generate/checks.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import {
  isGenerationRecord,
  isRegenerationRecord,
  readTraceRecords,
} from "@/lib/generations/store.ts";
import { MAX_STEER_LENGTH } from "@/types/generation.ts";
import { VoiceProfileSchema, type VoiceProfile } from "@/types/voice.ts";

/**
 * Half-pipeline runs: the two functions behind the Regenerate buttons and
 * behind `--hooks-only` / `--script-only`.
 *
 * The claim worth pinning is not that a regeneration returns text — the same
 * two model calls already had coverage — but that it lands in the trace as a
 * *child*. `parent_generation_id` is the whole measurable payoff of this phase,
 * and it is the one field that cannot be repaired after the file is written.
 */

const profile: VoiceProfile = VoiceProfileSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "data/voice-profile.example.json"), "utf8"),
  ),
);

/** Records what each call was handed, so the avoid-context is observable. */
class RecordingAdapter implements LlmAdapter {
  readonly provider = "mock" as const;
  readonly model = "mock-fixture-model";
  readonly requests: StructuredRequest<unknown>[] = [];

  private readonly inner = new MockAdapter();

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    return this.inner.generateStructured(req);
  }
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "regenerations-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

/** A first pass, to have something to regenerate away from. */
async function firstPass(hookCount = 5) {
  return generate({
    idea: SAMPLE_IDEA,
    profile,
    hookCount,
    adapter: new MockAdapter(),
    trace: { enabled: false },
  });
}

describe("normalizeSteer", () => {
  it("treats absent and blank alike, so callers never have to read an empty string", () => {
    expect(normalizeSteer(undefined)).toBeUndefined();
    expect(normalizeSteer(null)).toBeUndefined();
    expect(normalizeSteer("   \n ")).toBeUndefined();
  });

  it("trims a real steer rather than passing the creator's whitespace to the model", () => {
    expect(normalizeSteer("  make it blunter  ")).toBe("make it blunter");
  });

  it("rejects an over-long steer instead of silently truncating it", () => {
    expect(() => normalizeSteer("x".repeat(MAX_STEER_LENGTH + 1))).toThrow(
      GenerationInputError,
    );
    expect(normalizeSteer("x".repeat(MAX_STEER_LENGTH))).toHaveLength(MAX_STEER_LENGTH);
  });
});

describe("regenerateHooks", () => {
  it("re-runs only the hooks call and returns no script", async () => {
    const first = await firstPass();
    const adapter = new RecordingAdapter();

    const again = await regenerateHooks({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      avoid: first.hooks,
      parentGenerationId: first.meta.generationId,
      adapter,
      trace: { enabled: false },
    });

    expect(adapter.requests).toHaveLength(1);
    expect(again.target).toBe("hooks");
    expect(again.hooks).toHaveLength(5);
    expect(again.script).toBeNull();
    expect(again.meta.parentGenerationId).toBe(first.meta.generationId);
    expect(again.meta.regeneratedTarget).toBe("hooks");
    // A new run, not an edit of the old one.
    expect(again.meta.generationId).not.toBe(first.meta.generationId);
  });

  it("hands the rejected hooks to the model, and keeps them out of the cached prefix", async () => {
    const first = await firstPass();
    const adapter = new RecordingAdapter();

    await regenerateHooks({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      avoid: first.hooks,
      steer: "make them blunter",
      adapter,
      trace: { enabled: false },
    });

    const request = adapter.requests[0]!;
    const userTurn = request.messages[0]!.content;
    expect(userTurn).toContain(first.hooks[0]!.text);
    expect(userTurn).toContain("make them blunter");
    for (const block of request.system) {
      expect(block.text).not.toContain(first.hooks[0]!.text);
      expect(block.text).not.toContain("make them blunter");
    }
  });

  it("runs without avoid-context, which is what --hooks-only does", async () => {
    const result = await regenerateHooks({
      idea: SAMPLE_IDEA,
      profile,
      adapter: new MockAdapter(),
      trace: { enabled: false },
    });

    expect(result.hooks).not.toBeNull();
    expect(result.meta.parentGenerationId).toBeUndefined();
    expect(result.meta.regeneratedTarget).toBe("hooks");
  });

  it("rejects a bad idea or an over-long steer before spending a call", async () => {
    const adapter = new RecordingAdapter();

    await expect(
      regenerateHooks({ idea: "too short", profile, adapter, trace: { enabled: false } }),
    ).rejects.toThrow(GenerationInputError);
    await expect(
      regenerateHooks({
        idea: SAMPLE_IDEA,
        profile,
        steer: "x".repeat(MAX_STEER_LENGTH + 1),
        adapter,
        trace: { enabled: false },
      }),
    ).rejects.toThrow(GenerationInputError);

    expect(adapter.requests).toHaveLength(0);
  });
});

describe("regenerateScript", () => {
  it("re-runs only the script call, against the hooks it was handed", async () => {
    const first = await firstPass();
    const adapter = new RecordingAdapter();

    const again = await regenerateScript({
      idea: SAMPLE_IDEA,
      profile,
      hooks: first.hooks,
      steer: "lead with the mistake",
      parentGenerationId: first.meta.generationId,
      adapter,
      trace: { enabled: false },
    });

    expect(adapter.requests).toHaveLength(1);
    expect(again.target).toBe("script");
    expect(again.hooks).toBeNull();
    expect(again.script?.sections.length).toBeGreaterThan(0);
    expect(again.meta.parentGenerationId).toBe(first.meta.generationId);

    const request = adapter.requests[0]!;
    expect(request.messages[0]!.content).toContain("lead with the mistake");
    for (const block of request.system) {
      expect(block.text).not.toContain("lead with the mistake");
    }
  });

  it("refuses to write a script against no hook at all", async () => {
    const adapter = new RecordingAdapter();
    await expect(
      regenerateScript({
        idea: SAMPLE_IDEA,
        profile,
        hooks: [],
        adapter,
        trace: { enabled: false },
      }),
    ).rejects.toThrow(GenerationInputError);
    expect(adapter.requests).toHaveLength(0);
  });
});

describe("the regeneration trace record", () => {
  it("names its parent and the half it re-ran, and leaves the script null on hooks", async () => {
    const dir = tempDir();
    const first = await firstPass();

    const again = await regenerateHooks({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      avoid: first.hooks,
      steer: "blunter",
      parentGenerationId: first.meta.generationId,
      adapter: new MockAdapter(),
      trace: { enabled: true, dir },
    });

    const [record] = readTraceRecords({ dir }).records.filter(isGenerationRecord);
    expect(record?.generation_id).toBe(again.meta.generationId);
    expect(record?.parent_generation_id).toBe(first.meta.generationId);
    expect(record?.regenerated_target).toBe("hooks");
    expect(record?.steer).toBe("blunter");
    expect(record?.hooks).toHaveLength(5);
    expect(record?.script).toBeNull();
    // Four of the five gates — section completeness has no script to judge.
    expect(record?.checks.map((check) => check.name)).toEqual([
      "hook_count",
      "hook_distinctiveness",
      "banned_phrases",
      "groundedness",
    ]);
  });

  it("keeps the unchanged hooks on a script regeneration, so the record stands alone", async () => {
    const dir = tempDir();
    const first = await firstPass(4);

    await regenerateScript({
      idea: SAMPLE_IDEA,
      profile,
      hooks: first.hooks,
      parentGenerationId: first.meta.generationId,
      adapter: new MockAdapter(),
      trace: { enabled: true, dir },
    });

    const [record] = readTraceRecords({ dir }).records.filter(isGenerationRecord);
    expect(record?.regenerated_target).toBe("script");
    expect(record?.hooks).toHaveLength(4);
    expect(record?.script?.sections.length).toBeGreaterThan(0);
    expect(record?.steer).toBeUndefined();
    expect(record?.checks.map((check) => check.name)).toEqual([
      "banned_phrases",
      "section_completeness",
      "groundedness",
    ]);
  });

  it("records a half run with no parent, and does not count it as a regeneration", async () => {
    const dir = tempDir();
    await regenerateHooks({
      idea: SAMPLE_IDEA,
      profile,
      adapter: new MockAdapter(),
      trace: { enabled: true, dir },
    });

    const [record] = readTraceRecords({ dir }).records;
    expect(record).toBeDefined();
    expect(isRegenerationRecord(record!)).toBe(false);
  });

  it("writes nothing when tracing is switched off", async () => {
    const dir = tempDir();
    await regenerateHooks({
      idea: SAMPLE_IDEA,
      profile,
      adapter: new MockAdapter(),
      trace: { enabled: false, dir },
    });
    expect(readTraceRecords({ dir }).records).toEqual([]);
  });
});

describe("the check subsets a half run can answer", () => {
  it("judges hooks on everything except section completeness", async () => {
    const first = await firstPass();
    const checks = runHookChecks({
      idea: SAMPLE_IDEA,
      hooks: first.hooks,
      hookCount: 5,
      bannedPhrases: profile.traits.banned_phrases,
    });

    expect(checks.map((check) => check.name)).not.toContain("section_completeness");
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("still judges the untouched hooks when only the script was re-run", async () => {
    const first = await firstPass();
    // A phrase that appears only in a hook — written by the *parent* run, not
    // by this one. It is still on the creator's screen, so it still fails.
    const fromAHook = first.hooks[0]!.text.split(" ").slice(0, 4).join(" ");

    const checks = runScriptChecks({
      idea: SAMPLE_IDEA,
      hooks: first.hooks,
      script: first.script,
      bannedPhrases: [fromAHook],
    });

    expect(checks.map((check) => check.name)).toContain("section_completeness");
    expect(checks.find((check) => check.name === "banned_phrases")?.passed).toBe(false);
  });
});
