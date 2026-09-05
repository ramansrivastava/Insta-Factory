import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import type { LlmAdapter, StructuredRequest, StructuredResult } from "@/lib/llm/types.ts";
import { GenerationInputError, generate } from "@/lib/generate/pipeline.ts";
import { runLayer1Checks } from "@/lib/generate/checks.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import { HOOK_ANGLES, SECTION_KINDS } from "@/types/generation.ts";
import { VoiceProfileSchema, type VoiceProfile } from "@/types/voice.ts";

const profile: VoiceProfile = VoiceProfileSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "data/voice-profile.example.json"), "utf8"),
  ),
);

/** Records what each call was handed, so the pipeline's wiring is observable. */
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

describe("generate", () => {
  it("runs both calls in sequence and returns hooks, script and meta", async () => {
    const adapter = new RecordingAdapter();
    const result = await generate({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      adapter,
    });

    expect(adapter.requests.map((request) => request.kind)).toEqual(["hooks-5", "script"]);
    expect(result.hooks).toHaveLength(5);
    expect(result.script.sections.map((section) => section.kind)).toEqual([
      ...SECTION_KINDS,
    ]);
    expect(result.meta.provider).toBe("mock");
    expect(result.meta.model).toBe("mock-fixture-model");
    expect(result.meta.cacheReadTokens).toBe(0);
    expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("conditions the script call on the hooks the first call produced", async () => {
    const adapter = new RecordingAdapter();
    const result = await generate({ idea: SAMPLE_IDEA, profile, hookCount: 3, adapter });

    const scriptUserTurn = adapter.requests[1]!.messages[0]!.content;
    for (const hook of result.hooks) {
      expect(scriptUserTurn).toContain(hook.text);
    }
  });

  it("defaults the hook count rather than requiring one", async () => {
    const result = await generate({
      idea: SAMPLE_IDEA,
      profile,
      adapter: new RecordingAdapter(),
    });
    expect(result.hooks).toHaveLength(5);
  });

  it("rejects an idea too thin to elaborate on", async () => {
    await expect(
      generate({ idea: "reels", profile, adapter: new RecordingAdapter() }),
    ).rejects.toBeInstanceOf(GenerationInputError);
  });

  it("produces hooks whose angles all come from the closed enum and all differ", async () => {
    const result = await generate({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 6,
      adapter: new RecordingAdapter(),
    });

    const angles = result.hooks.map((hook) => hook.angle);
    expect(new Set(angles).size).toBe(angles.length);
    for (const angle of angles) {
      expect(HOOK_ANGLES).toContain(angle);
    }
  });

  /**
   * The end-to-end guarantee the eval depends on: the shipped fixtures, run
   * through the real pipeline, satisfy every Layer-1 gate. If a fixture drifts
   * away from `SAMPLE_IDEA`, this fails here rather than in the eval.
   */
  it("passes every Layer-1 check on the sample idea", async () => {
    const result = await generate({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      adapter: new RecordingAdapter(),
    });

    const checks = runLayer1Checks({
      idea: SAMPLE_IDEA,
      hooks: result.hooks,
      script: result.script,
      hookCount: 5,
      bannedPhrases: profile.traits.banned_phrases,
    });

    const failures = checks.filter((check) => !check.passed);
    expect(failures.map((check) => `${check.name}: ${check.details}`)).toEqual([]);
  });

  it("works for every hook count the product offers", async () => {
    for (const hookCount of [3, 4, 5, 6]) {
      const result = await generate({
        idea: SAMPLE_IDEA,
        profile,
        hookCount,
        adapter: new RecordingAdapter(),
      });
      expect(result.hooks).toHaveLength(hookCount);
    }
  });
});
