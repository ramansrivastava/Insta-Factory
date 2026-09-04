import { describe, expect, it } from "vitest";

import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import { LlmSchemaError } from "@/lib/llm/errors.ts";
import {
  MAX_SAMPLES,
  MIN_SAMPLES,
  VOICE_DISTILL_KIND,
  VoiceDistillError,
  buildDistillRequest,
  distillVoiceTraits,
  normalizeSamples,
  toDraftProfile,
} from "@/lib/voice/distill.ts";
import { VoiceProfileSchema } from "@/types/voice.ts";

const SAMPLES = [
  "You don't need a program. You need to show up twice a week.",
  "Three years in and I still can't do a pull-up unassisted.",
  "HOOK: Your form isn't bad. Your load is.",
];

describe("normalizeSamples", () => {
  it("accepts the documented 3-5 window", () => {
    expect(normalizeSamples(SAMPLES)).toHaveLength(MIN_SAMPLES);
    expect(normalizeSamples([...SAMPLES, "four", "five"])).toHaveLength(MAX_SAMPLES);
  });

  it("rejects too few and too many samples", () => {
    expect(() => normalizeSamples(SAMPLES.slice(0, 2))).toThrowError(VoiceDistillError);
    expect(() =>
      normalizeSamples([...SAMPLES, "four", "five", "six"]),
    ).toThrowError(VoiceDistillError);
  });

  it("ignores blank samples when counting", () => {
    expect(() => normalizeSamples([...SAMPLES, "   "])).not.toThrow();
    expect(() => normalizeSamples([SAMPLES[0]!, "  ", SAMPLES[1]!])).toThrowError(
      VoiceDistillError,
    );
  });
});

describe("buildDistillRequest", () => {
  it("builds one cacheable structured request carrying every sample", () => {
    const request = buildDistillRequest(SAMPLES);

    expect(request.kind).toBe(VOICE_DISTILL_KIND);
    expect(request.system).toHaveLength(1);
    expect(request.system[0]!.cacheable).toBe(true);
    expect(request.messages).toHaveLength(1);
    for (const sample of SAMPLES) {
      expect(request.messages[0]!.content).toContain(sample);
    }
  });
});

describe("distillVoiceTraits", () => {
  it("runs offline against the committed mock fixture", async () => {
    const { traits, provider } = await distillVoiceTraits(SAMPLES, {
      adapter: new MockAdapter(),
    });

    expect(provider).toBe("mock");
    expect(traits.tone.length).toBeGreaterThan(0);
    expect(traits.emoji_usage).toBe("rare");
    expect(traits.banned_phrases).toContain("game changer");
  });

  it("normalises the distilled banned-phrase list", async () => {
    const adapter = new MockAdapter({
      fixtures: {
        [VOICE_DISTILL_KIND]: {
          tone: "blunt",
          sentence_rhythm: "short",
          opener_patterns: [],
          recurring_phrases: [],
          banned_phrases: ["Game changer", "game-changer!", "no excuses"],
          emoji_usage: "none",
          vocabulary_register: "casual",
        },
      },
    });

    const { traits } = await distillVoiceTraits(SAMPLES, { adapter });
    expect(traits.banned_phrases).toEqual(["Game changer", "no excuses"]);
  });

  it("rejects a model response that does not match the traits schema", async () => {
    const adapter = new MockAdapter({
      fixtures: { [VOICE_DISTILL_KIND]: { tone: "blunt", emoji_usage: "sometimes" } },
    });

    await expect(distillVoiceTraits(SAMPLES, { adapter })).rejects.toBeInstanceOf(
      LlmSchemaError,
    );
  });
});

describe("toDraftProfile", () => {
  it("produces a schema-valid profile and carries existing examples over", async () => {
    const { traits } = await distillVoiceTraits(SAMPLES, { adapter: new MockAdapter() });
    const existing = VoiceProfileSchema.parse({
      traits,
      examples: [{ type: "caption", text: "kept", tags: [] }],
      updated_at: "2026-09-04T12:00:00.000Z",
    });

    const draft = toDraftProfile(traits, existing);

    expect(VoiceProfileSchema.safeParse(draft).success).toBe(true);
    expect(draft.examples).toEqual(existing.examples);
    expect(draft.updated_at).not.toBe(existing.updated_at);
    expect(toDraftProfile(traits).examples).toEqual([]);
  });
});
