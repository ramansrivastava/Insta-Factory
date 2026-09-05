import { describe, expect, it } from "vitest";

import {
  addExample,
  blankExample,
  draftFromProfile,
  draftProblems,
  draftToUpdate,
  emptyDraft,
  exampleCapState,
  parseTags,
  removeAt,
  replaceAt,
  sampleReadiness,
  type VoiceDraft,
} from "@/components/voice/voice-draft.ts";
import { SEED_BANNED_PHRASES, mergeBannedPhrases } from "@/lib/voice/defaults.ts";
import {
  VOICE_SETUP_PATH,
  isSkipVoiceSetupRequested,
  shouldRedirectToVoiceSetup,
} from "@/lib/voice/onboarding.ts";
import {
  DISTILL_MIN_SAMPLES,
  MIN_SAMPLE_LENGTH,
  VoiceProfileUpdateSchema,
} from "@/types/voice-api.ts";
import {
  EXAMPLE_WARN_THRESHOLD,
  MAX_EXAMPLES,
  type VoiceProfile,
} from "@/types/voice.ts";

/**
 * The pure logic behind the voice editor.
 *
 * Rendering is left to a browser; what is worth pinning is the arithmetic the
 * UI is judged on — that the cap it enforces is the schema's cap, that the
 * past-six warning explains itself rather than just appearing, and that a
 * profile-less first load has exactly one destination and exactly one way past
 * it.
 */

function draft(overrides: Partial<VoiceDraft> = {}): VoiceDraft {
  return {
    tone: "Blunt and warm at the same time.",
    sentence_rhythm: "Short declaratives, often fragments.",
    opener_patterns: ["Flat contradiction of a common belief"],
    recurring_phrases: ["here's the boring part"],
    banned_phrases: ["unlock the power of"],
    emoji_usage: "rare",
    vocabulary_register: "casual",
    examples: [],
    ...overrides,
  };
}

function example(index: number) {
  return {
    type: "caption" as const,
    text: `Example ${index}: show up twice a week for three months.`,
    tags: ["caption"],
  };
}

describe("the seeded banned phrases", () => {
  it("ships the AI tells the creator would otherwise have to think of", () => {
    expect(SEED_BANNED_PHRASES).toContain("unlock the power of");
    expect(SEED_BANNED_PHRASES).toContain("in today's fast-paced world");
    expect(SEED_BANNED_PHRASES).toContain("dive into");
  });

  it("pre-seeds an empty draft so the list is never a blank box", () => {
    expect(emptyDraft().banned_phrases).toEqual([...SEED_BANNED_PHRASES]);
  });

  it("merges without duplicating phrases that differ only in case or punctuation", () => {
    const merged = mergeBannedPhrases(["Dive into!"], ["dive into", "game changer"]);
    expect(merged.filter((phrase) => phrase.toLowerCase().startsWith("dive"))).toHaveLength(1);
    expect(merged).toContain("game changer");
  });
});

describe("exampleCapState", () => {
  it("says nothing special in the sweet spot", () => {
    const state = exampleCapState(4);
    expect(state.atCap).toBe(false);
    expect(state.overWarnThreshold).toBe(false);
    expect(state.message).toBeNull();
  });

  it("nudges an empty example set toward 3-6", () => {
    expect(exampleCapState(0).message).toContain("3 to 6");
  });

  it("explains past the threshold that more examples make matching WORSE", () => {
    const state = exampleCapState(EXAMPLE_WARN_THRESHOLD + 1);
    expect(state.overWarnThreshold).toBe(true);
    expect(state.atCap).toBe(false);
    // The point of surfacing this is that a silent limit reads as a bug.
    expect(state.message).toContain("worse");
  });

  it("reports the hard cap as a stop, with the remedy", () => {
    const state = exampleCapState(MAX_EXAMPLES);
    expect(state.atCap).toBe(true);
    expect(state.remaining).toBe(0);
    expect(state.message).toContain("Remove one");
  });
});

describe("example list operations", () => {
  it("refuses to add past the cap", () => {
    const examples = Array.from({ length: MAX_EXAMPLES }, (_, index) => example(index));
    expect(addExample(examples, blankExample())).toHaveLength(MAX_EXAMPLES);
  });

  it("adds below the cap", () => {
    expect(addExample([example(1)], blankExample())).toHaveLength(2);
  });

  it("removes and replaces by position", () => {
    const examples = [example(1), example(2), example(3)];
    expect(removeAt(examples, 1).map((item) => item.text)).toEqual([
      example(1).text,
      example(3).text,
    ]);
    expect(replaceAt(examples, 0, example(9))[0]?.text).toBe(example(9).text);
  });
});

describe("the UI cap and the wire cap are the same cap", () => {
  it("rejects a draft the server would also reject", () => {
    const overCap = draft({
      examples: Array.from({ length: MAX_EXAMPLES + 1 }, (_, index) => example(index)),
    });
    expect(VoiceProfileUpdateSchema.safeParse(draftToUpdate(overCap)).success).toBe(false);
    expect(draftProblems(overCap).join(" ")).toContain(String(MAX_EXAMPLES));
  });

  it("accepts a draft at exactly the cap", () => {
    const atCap = draft({
      examples: Array.from({ length: MAX_EXAMPLES }, (_, index) => example(index)),
    });
    expect(draftProblems(atCap)).toEqual([]);
  });
});

describe("draftToUpdate", () => {
  it("drops half-typed blank rows instead of sending them", () => {
    const update = draftToUpdate(
      draft({
        opener_patterns: ["A bare number", "   ", ""],
        examples: [example(1), { type: "caption", text: "   ", tags: [] }],
      }),
    );

    expect(update.traits.opener_patterns).toEqual(["A bare number"]);
    expect(update.examples).toHaveLength(1);
  });

  it("de-duplicates banned phrases the way the matcher compares them", () => {
    const update = draftToUpdate(draft({ banned_phrases: ["Dive into", "dive into!"] }));
    expect(update.traits.banned_phrases).toHaveLength(1);
  });

  it("round-trips a profile through the draft unchanged", () => {
    const profile: VoiceProfile = {
      traits: draftToUpdate(draft({ examples: [example(1)] })).traits,
      examples: [example(1)],
      updated_at: "2026-09-05T12:00:00.000Z",
    };
    expect(draftToUpdate(draftFromProfile(profile))).toEqual({
      traits: profile.traits,
      examples: profile.examples,
    });
  });
});

describe("draftProblems", () => {
  it("passes a complete draft", () => {
    expect(draftProblems(draft())).toEqual([]);
  });

  it("names the field when tone has been cleared", () => {
    // Clearing a field mid-edit is allowed; saving one is not.
    expect(draftProblems(draft({ tone: "" })).join(" ")).toContain("tone");
  });

  it("names the field when the rhythm is blank", () => {
    expect(draftProblems(draft({ sentence_rhythm: "  " })).join(" ")).toContain(
      "sentence_rhythm",
    );
  });
});

describe("parseTags", () => {
  it("splits on commas, trims, and drops duplicates case-insensitively", () => {
    expect(parseTags(" storytime , Mythbust, storytime , ")).toEqual([
      "storytime",
      "Mythbust",
    ]);
  });

  it("stops at the schema's ten-tag limit", () => {
    const many = Array.from({ length: 15 }, (_, index) => `tag${index}`).join(",");
    expect(parseTags(many)).toHaveLength(10);
  });
});

describe("sampleReadiness", () => {
  const long = "a".repeat(MIN_SAMPLE_LENGTH);

  it("is not ready below the minimum sample count", () => {
    const readiness = sampleReadiness([{ text: long }, { text: long }]);
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain(String(DISTILL_MIN_SAMPLES));
  });

  it("does not count a fragment as a sample", () => {
    const readiness = sampleReadiness([{ text: long }, { text: long }, { text: "hi" }]);
    expect(readiness.usable).toBe(2);
    expect(readiness.ready).toBe(false);
  });

  it("is ready at three usable samples", () => {
    const readiness = sampleReadiness([{ text: long }, { text: long }, { text: long }]);
    expect(readiness.ready).toBe(true);
  });

  it("refuses more than the window rather than silently truncating", () => {
    const readiness = sampleReadiness(Array.from({ length: 6 }, () => ({ text: long })));
    expect(readiness.ready).toBe(false);
  });
});

describe("first-run routing", () => {
  it("sends a profile-less first load to the voice editor", () => {
    expect(shouldRedirectToVoiceSetup({ profileExists: false, skipRequested: false })).toBe(
      true,
    );
    expect(VOICE_SETUP_PATH).toContain("/voice");
  });

  it("leaves a creator with a profile on the generator", () => {
    expect(shouldRedirectToVoiceSetup({ profileExists: true, skipRequested: false })).toBe(
      false,
    );
  });

  it("honours the escape hatch, so the redirect is never a trap", () => {
    expect(shouldRedirectToVoiceSetup({ profileExists: false, skipRequested: true })).toBe(
      false,
    );
    expect(isSkipVoiceSetupRequested({ skipVoiceSetup: "1" })).toBe(true);
    expect(isSkipVoiceSetupRequested({ skipVoiceSetup: ["1"] })).toBe(true);
    expect(isSkipVoiceSetupRequested({})).toBe(false);
    expect(isSkipVoiceSetupRequested(undefined)).toBe(false);
  });
});
