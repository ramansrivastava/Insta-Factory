import { describe, expect, it } from "vitest";

import {
  containsPhrase,
  findBannedPhrases,
  normalizeBannedPhrases,
  normalizePhrase,
} from "@/lib/voice/banned.ts";

describe("normalizePhrase", () => {
  it("folds case, punctuation and whitespace", () => {
    expect(normalizePhrase("Let's DIVE in!!")).toBe("lets dive in");
    expect(normalizePhrase("  game—changer  ")).toBe("game changer");
    expect(normalizePhrase("“Game Changer”")).toBe("game changer");
  });

  it("returns an empty string for punctuation-only input", () => {
    expect(normalizePhrase("!!!")).toBe("");
    expect(normalizePhrase("   ")).toBe("");
  });
});

describe("normalizeBannedPhrases", () => {
  it("drops blanks and duplicates that differ only by case or punctuation", () => {
    expect(
      normalizeBannedPhrases(["Game changer", "game-changer!", "  ", "no excuses"]),
    ).toEqual(["Game changer", "no excuses"]);
  });
});

describe("findBannedPhrases", () => {
  const banned = ["game changer", "Let's dive in", "no excuses"];

  it("matches regardless of case and punctuation", () => {
    expect(findBannedPhrases("This is a GAME-CHANGER, truly.", banned)).toEqual([
      "game changer",
    ]);
    expect(findBannedPhrases("Okay — lets dive in!", banned)).toEqual(["Let's dive in"]);
  });

  it("returns nothing when no banned phrase appears", () => {
    expect(findBannedPhrases("Strip the weight. Keep the tempo.", banned)).toEqual([]);
  });

  it("respects token boundaries so short phrases do not fire inside words", () => {
    expect(containsPhrase("she said nothing", ["ai"][0]!)).toBe(false);
    expect(containsPhrase("I use ai daily", "AI")).toBe(true);
  });

  it("reports each banned phrase at most once", () => {
    expect(findBannedPhrases("game changer, what a game changer.", banned)).toEqual([
      "game changer",
    ]);
  });

  it("ignores empty entries in the banned list", () => {
    expect(findBannedPhrases("anything at all", ["", "   "])).toEqual([]);
  });
});
