import { describe, expect, it } from "vitest";

import {
  EXAMPLE_WARN_THRESHOLD,
  MAX_EXAMPLES,
  VoiceProfileSchema,
  collectVoiceProfileWarnings,
  type VoiceProfileInput,
} from "@/types/voice.ts";

function example(index: number) {
  return { type: "caption" as const, text: `sample ${index}`, tags: ["caption"] };
}

function profile(exampleCount: number): VoiceProfileInput {
  return {
    traits: {
      tone: "blunt and warm",
      sentence_rhythm: "short declaratives, occasional fragments",
      opener_patterns: ["flat contradiction of a common belief"],
      recurring_phrases: ["here's the boring part"],
      banned_phrases: ["game changer"],
      emoji_usage: "rare",
      vocabulary_register: "casual",
    },
    examples: Array.from({ length: exampleCount }, (_, i) => example(i)),
    updated_at: "2026-09-04T12:00:00.000Z",
  };
}

describe("VoiceProfileSchema", () => {
  it("round-trips a profile through parse and serialise unchanged", () => {
    const input = profile(3);
    const parsed = VoiceProfileSchema.parse(input);
    const reparsed = VoiceProfileSchema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(parsed);
    expect(parsed.traits.emoji_usage).toBe("rare");
    expect(parsed.examples).toHaveLength(3);
  });

  it("defaults optional list fields so a hand-edited profile can omit them", () => {
    const parsed = VoiceProfileSchema.parse({
      traits: {
        tone: "blunt",
        sentence_rhythm: "short",
        emoji_usage: "none",
        vocabulary_register: "professional",
      },
      updated_at: "2026-09-04T12:00:00.000Z",
    });

    expect(parsed.traits.opener_patterns).toEqual([]);
    expect(parsed.traits.banned_phrases).toEqual([]);
    expect(parsed.examples).toEqual([]);
  });

  it("accepts exactly the cap of examples", () => {
    expect(VoiceProfileSchema.safeParse(profile(MAX_EXAMPLES)).success).toBe(true);
  });

  it("rejects more than the cap of examples", () => {
    const result = VoiceProfileSchema.safeParse(profile(MAX_EXAMPLES + 1));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "examples")).toBe(true);
    }
  });

  it("rejects an unknown example type and a non-ISO timestamp", () => {
    const bad = { ...profile(1), updated_at: "yesterday" };
    expect(VoiceProfileSchema.safeParse(bad).success).toBe(false);

    const badType = {
      ...profile(1),
      examples: [{ type: "tweet", text: "hi", tags: [] }],
    };
    expect(VoiceProfileSchema.safeParse(badType).success).toBe(false);
  });

  it("warns above the soft example threshold without failing validation", () => {
    const parsed = VoiceProfileSchema.parse(profile(EXAMPLE_WARN_THRESHOLD + 1));
    const warnings = collectVoiceProfileWarnings(parsed);

    expect(warnings.some((w) => w.includes(String(EXAMPLE_WARN_THRESHOLD)))).toBe(true);
  });

  it("does not warn at or below the soft threshold", () => {
    const parsed = VoiceProfileSchema.parse(profile(EXAMPLE_WARN_THRESHOLD));

    expect(collectVoiceProfileWarnings(parsed)).toEqual([]);
  });

  it("warns when there are no examples and no banned phrases", () => {
    const parsed = VoiceProfileSchema.parse({
      ...profile(0),
      traits: { ...profile(0).traits, banned_phrases: [] },
    });

    expect(collectVoiceProfileWarnings(parsed)).toHaveLength(2);
  });
});
