import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  distillVoiceProfile,
  readVoiceProfile,
  voiceProfileExists,
  writeVoiceProfile,
} from "@/lib/api/voice-service.ts";
import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import { VoiceProfileError, voiceProfilePath } from "@/lib/voice/store.ts";
import { MAX_EXAMPLES, type VoiceExample } from "@/types/voice.ts";
import type { VoiceProfileUpdate } from "@/types/voice-api.ts";

/**
 * The write paths, against a temp root so no test can clobber the profile of
 * whoever is running them.
 *
 * The cap is asserted here as well as at the route: the route proves the
 * request is rejected, this proves the *store* would reject it too, so the
 * limit survives a future caller that skips the wire schema.
 */

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "voice-service-"));
  roots.push(root);
  mkdirSync(path.join(root, "data"), { recursive: true });
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function example(index: number): VoiceExample {
  return {
    type: "caption",
    text: `Example ${index}: you do not need a program, you need to show up twice a week.`,
    tags: ["caption"],
  };
}

function update(exampleCount = 2): VoiceProfileUpdate {
  return {
    traits: {
      tone: "Blunt and warm at the same time.",
      sentence_rhythm: "Short declaratives, often fragments.",
      opener_patterns: ["Flat contradiction of a common belief"],
      recurring_phrases: ["here's the boring part"],
      banned_phrases: ["unlock the power of"],
      emoji_usage: "rare",
      vocabulary_register: "casual",
    },
    examples: Array.from({ length: exampleCount }, (_, index) => example(index)),
  };
}

describe("readVoiceProfile", () => {
  it("reports a missing profile as a first-run state rather than an error", () => {
    const body = readVoiceProfile({ root: tempRoot() });

    expect(body.ok).toBe(true);
    expect(body.exists).toBe(false);
    expect(body.source).toBe("none");
    expect(body.profile).toBeNull();
    expect(body.seedBannedPhrases).toContain("in today's fast-paced world");
  });

  it("does not fall back to the committed example profile", () => {
    const root = tempRoot();
    // The generator falls back so it can still produce something. An editor
    // that did would invite the creator to save a stranger's voice as theirs.
    writeFileSync(
      path.join(root, "data", "voice-profile.example.json"),
      JSON.stringify({ ...update(), updated_at: new Date().toISOString() }),
      "utf8",
    );

    expect(readVoiceProfile({ root }).exists).toBe(false);
  });

  it("surfaces a malformed profile instead of silently offering a blank one", () => {
    const root = tempRoot();
    writeFileSync(voiceProfilePath(root), "{ not json", "utf8");

    expect(() => readVoiceProfile({ root })).toThrow(VoiceProfileError);
    // ...and onboarding does not fire, because the file is there to be fixed.
    expect(voiceProfileExists({ root })).toBe(true);
  });
});

describe("writeVoiceProfile", () => {
  it("saves a corrected profile and stamps it", () => {
    const root = tempRoot();
    const body = writeVoiceProfile(update(), { root });

    expect(body.exists).toBe(true);
    expect(body.source).toBe("saved");
    expect(body.profile?.traits.tone).toBe(update().traits.tone);
    expect(Date.parse(body.profile?.updated_at ?? "")).not.toBeNaN();

    const reloaded = readVoiceProfile({ root });
    expect(reloaded.exists).toBe(true);
    expect(reloaded.profile?.examples).toHaveLength(2);
    expect(voiceProfileExists({ root })).toBe(true);
  });

  it("accepts exactly the example cap — the limit is inclusive", () => {
    const root = tempRoot();
    const body = writeVoiceProfile(update(MAX_EXAMPLES), { root });
    expect(body.profile?.examples).toHaveLength(MAX_EXAMPLES);
    // Past six is allowed but flagged, and the flag says why.
    expect(body.warnings.join(" ")).toContain("dilute");
  });

  it("refuses one example past the cap, and writes nothing when it does", () => {
    const root = tempRoot();

    expect(() => writeVoiceProfile(update(MAX_EXAMPLES + 1), { root })).toThrow(
      VoiceProfileError,
    );
    expect(existsSync(voiceProfilePath(root))).toBe(false);
  });

  it("does not truncate a good profile when a bad one is rejected", () => {
    const root = tempRoot();
    writeVoiceProfile(update(2), { root });

    expect(() => writeVoiceProfile(update(MAX_EXAMPLES + 1), { root })).toThrow();
    expect(readVoiceProfile({ root }).profile?.examples).toHaveLength(2);
  });
});

describe("distillVoiceProfile", () => {
  const samples = [example(1), example(2), example(3)];

  it("returns a draft and writes absolutely nothing", async () => {
    const root = tempRoot();
    const body = await distillVoiceProfile(samples, { root, adapter: new MockAdapter() });

    expect(body.source).toBe("draft");
    expect(body.profile?.traits.tone.length).toBeGreaterThan(0);
    // The pasted samples become the draft's examples — they are what produced
    // these traits, so asking for them twice would be the bug.
    expect(body.profile?.examples).toEqual(samples);
    expect(existsSync(voiceProfilePath(root))).toBe(false);
  });

  it("leaves an existing saved profile untouched", async () => {
    const root = tempRoot();
    const saved = writeVoiceProfile(update(1), { root });

    await distillVoiceProfile(samples, { root, adapter: new MockAdapter() });

    expect(readVoiceProfile({ root }).profile).toEqual(saved.profile);
  });
});
