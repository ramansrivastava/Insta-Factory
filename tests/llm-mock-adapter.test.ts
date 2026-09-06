import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import { LlmConfigError, LlmSchemaError } from "@/lib/llm/errors.ts";
import { ProbeSchema, buildProbeRequest } from "@/lib/llm/probe.ts";
import type { StructuredRequest } from "@/lib/llm/types.ts";
import { buildHooksRequest } from "@/lib/prompts/hooks.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import { VoiceProfileSchema, type VoiceProfile } from "@/types/voice.ts";

const profile: VoiceProfile = VoiceProfileSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "data/voice-profile.example.json"), "utf8"),
  ),
);

describe("MockAdapter", () => {
  it("returns the on-disk fixture for a request kind", async () => {
    const adapter = new MockAdapter();
    const result = await adapter.generateStructured(buildProbeRequest());

    expect(result.provider).toBe("mock");
    expect(result.data.ok).toBe(true);
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(ProbeSchema.safeParse(result.data).success).toBe(true);
  });

  it("is deterministic across calls", async () => {
    const adapter = new MockAdapter();
    const first = await adapter.generateStructured(buildProbeRequest());
    const second = await adapter.generateStructured(buildProbeRequest());

    expect(second).toEqual(first);
    expect(first.latencyMs).toBe(0);
    expect(first.usage.cacheReadInputTokens).toBe(0);
  });

  it("rejects a fixture that does not match the schema", async () => {
    const adapter = new MockAdapter({ fixtures: { probe: { ok: false } } });

    await expect(adapter.generateStructured(buildProbeRequest())).rejects.toBeInstanceOf(
      LlmSchemaError,
    );
  });

  it("reports a missing fixture as a config error", async () => {
    const adapter = new MockAdapter();
    const request: StructuredRequest<{ a: string }> = {
      ...buildProbeRequest(),
      kind: "definitely-not-a-fixture",
      schema: z.object({ a: z.string() }),
    };

    await expect(adapter.generateStructured(request)).rejects.toBeInstanceOf(
      LlmConfigError,
    );
  });

  it("answers a regeneration from the alternate fixture for that kind", async () => {
    const adapter = new MockAdapter();
    const first = await adapter.generateStructured(
      buildHooksRequest({ idea: SAMPLE_IDEA, profile, hookCount: 4 }),
    );
    const second = await adapter.generateStructured(
      buildHooksRequest({
        idea: SAMPLE_IDEA,
        profile,
        hookCount: 4,
        avoid: first.data.hooks,
      }),
    );

    const round1 = first.data.hooks.map((hook) => hook.text);
    const round2 = second.data.hooks.map((hook) => hook.text);
    expect(round2).toHaveLength(4);
    // The point of the whole feature on the mock path: round two is not round one.
    expect(round2.some((text) => round1.includes(text))).toBe(false);
  });

  it("falls back to the plain fixture when a kind has no alternate", async () => {
    const adapter = new MockAdapter({
      fixtures: { "hooks-4": { hooks: [] } },
    });
    const request = buildHooksRequest({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 4,
      avoid: [
        { text: "already seen", angle: "contrarian", rationale: "rejected" },
      ],
    });

    // No `hooks-4-regenerated` registered, so this resolves to `hooks-4` and
    // fails on its schema rather than on a missing fixture.
    await expect(adapter.generateStructured(request)).rejects.toBeInstanceOf(
      LlmSchemaError,
    );
  });

  it("refuses a request kind that could escape the fixture directory", async () => {
    const adapter = new MockAdapter();
    const request = { ...buildProbeRequest(), kind: "../../package" };

    await expect(adapter.generateStructured(request)).rejects.toBeInstanceOf(
      LlmConfigError,
    );
  });
});
