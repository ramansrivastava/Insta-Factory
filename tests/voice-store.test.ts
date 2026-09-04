import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  VOICE_PROFILE_EXAMPLE_FILE,
  VoiceProfileError,
  loadVoiceProfile,
  saveVoiceProfile,
  voiceProfilePath,
} from "@/lib/voice/store.ts";
import { MAX_EXAMPLES, VoiceProfileSchema, type VoiceProfileInput } from "@/types/voice.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "voice-store-"));
  roots.push(root);
  mkdirSync(path.join(root, "data"), { recursive: true });
  return root;
}

function fixtureProfile(exampleCount = 2): VoiceProfileInput {
  return {
    traits: {
      tone: "blunt and warm",
      sentence_rhythm: "short declaratives",
      opener_patterns: ["flat contradiction"],
      recurring_phrases: ["here's the boring part"],
      banned_phrases: ["game changer"],
      emoji_usage: "rare",
      vocabulary_register: "casual",
    },
    examples: Array.from({ length: exampleCount }, (_, i) => ({
      type: "caption" as const,
      text: `sample ${i}`,
      tags: ["caption"],
    })),
    updated_at: "2026-09-04T12:00:00.000Z",
  };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("voice profile store", () => {
  it("saves and reloads a profile unchanged apart from the timestamp", () => {
    const root = tempRoot();
    const saved = saveVoiceProfile(fixtureProfile(), { root });
    const loaded = loadVoiceProfile({ root });

    expect(loaded.path).toBe(voiceProfilePath(root));
    expect(loaded.profile.traits).toEqual(saved.profile.traits);
    expect(loaded.profile.examples).toEqual(saved.profile.examples);
    expect(loaded.profile.updated_at).toBe(saved.profile.updated_at);
    expect(loaded.usedExample).toBe(false);
  });

  it("stamps updated_at on save, and honours stampUpdatedAt: false", () => {
    const root = tempRoot();

    const stamped = saveVoiceProfile(fixtureProfile(), { root });
    expect(stamped.profile.updated_at).not.toBe("2026-09-04T12:00:00.000Z");

    const kept = saveVoiceProfile(fixtureProfile(), { root, stampUpdatedAt: false });
    expect(kept.profile.updated_at).toBe("2026-09-04T12:00:00.000Z");
  });

  it("reports a missing file as a typed 'missing' error", () => {
    const root = tempRoot();

    try {
      loadVoiceProfile({ root });
      expect.unreachable("expected a VoiceProfileError");
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceProfileError);
      expect((error as VoiceProfileError).code).toBe("missing");
      expect((error as VoiceProfileError).path).toBe(voiceProfilePath(root));
    }
  });

  it("reports unparseable JSON as a typed 'malformed' error", () => {
    const root = tempRoot();
    writeFileSync(voiceProfilePath(root), "{ traits: not json ", "utf8");

    try {
      loadVoiceProfile({ root });
      expect.unreachable("expected a VoiceProfileError");
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceProfileError);
      expect((error as VoiceProfileError).code).toBe("malformed");
    }
  });

  it("reports schema-valid JSON that is not a profile as 'invalid'", () => {
    const root = tempRoot();
    writeFileSync(voiceProfilePath(root), JSON.stringify({ traits: {} }), "utf8");

    try {
      loadVoiceProfile({ root });
      expect.unreachable("expected a VoiceProfileError");
    } catch (error) {
      expect((error as VoiceProfileError).code).toBe("invalid");
    }
  });

  it("refuses to save a profile that exceeds the example cap", () => {
    const root = tempRoot();

    try {
      saveVoiceProfile(fixtureProfile(MAX_EXAMPLES + 1), { root });
      expect.unreachable("expected a VoiceProfileError");
    } catch (error) {
      expect((error as VoiceProfileError).code).toBe("invalid");
      expect((error as VoiceProfileError).message).toContain("examples");
    }

    // The rejected write must not have created a file.
    expect(() => loadVoiceProfile({ root })).toThrowError(VoiceProfileError);
  });

  it("surfaces example-count warnings without failing the load", () => {
    const root = tempRoot();
    saveVoiceProfile(fixtureProfile(8), { root });

    const loaded = loadVoiceProfile({ root });
    expect(loaded.profile.examples).toHaveLength(8);
    expect(loaded.warnings.length).toBeGreaterThan(0);
  });

  it("falls back to the committed example profile only when asked", () => {
    const root = tempRoot();
    writeFileSync(
      path.join(root, VOICE_PROFILE_EXAMPLE_FILE),
      JSON.stringify(VoiceProfileSchema.parse(fixtureProfile())),
      "utf8",
    );

    expect(() => loadVoiceProfile({ root })).toThrowError(VoiceProfileError);

    const loaded = loadVoiceProfile({ root, fallbackToExample: true });
    expect(loaded.usedExample).toBe(true);
    expect(loaded.profile.traits.tone).toBe("blunt and warm");
  });
});

describe("the committed example profile", () => {
  it("is a valid profile the app can boot on", () => {
    const loaded = loadVoiceProfile({ fallbackToExample: true, path: "/nonexistent" });

    expect(loaded.usedExample).toBe(true);
    expect(loaded.profile.examples.length).toBeGreaterThanOrEqual(3);
    expect(loaded.profile.traits.banned_phrases.length).toBeGreaterThan(0);
    expect(loaded.warnings).toEqual([]);
  });
});
