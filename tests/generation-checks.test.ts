import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkBannedPhrases,
  checkGroundedness,
  checkHookCount,
  checkHookDistinctiveness,
  checkSectionCompleteness,
  extractCapitalisedEntities,
  extractNumbers,
  findGroundednessViolations,
  runLayer1Checks,
} from "@/lib/generate/checks.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import { ScriptSchema, type Hook, type Script } from "@/types/generation.ts";

/** The mock adapter's own fixtures — the checks must pass on what ships. */
function loadFixture(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(process.cwd(), relative), "utf8"));
}

const groundedScript: Script = ScriptSchema.parse(loadFixture("fixtures/llm/script.json"));
const ungroundedScript: Script = ScriptSchema.parse(
  loadFixture("fixtures/generation/ungrounded-script.json"),
);
const fixtureHooks: Hook[] = (
  loadFixture("fixtures/llm/hooks-5.json") as { hooks: Hook[] }
).hooks;

describe("checkHookCount", () => {
  it("passes when the count matches exactly", () => {
    expect(checkHookCount(fixtureHooks, 5).passed).toBe(true);
  });

  it("fails when the model returns fewer than asked", () => {
    const result = checkHookCount(fixtureHooks.slice(0, 4), 5);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("expected 5 hooks, got 4");
  });
});

describe("checkHookDistinctiveness", () => {
  it("passes when every angle differs", () => {
    const result = checkHookDistinctiveness(fixtureHooks);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("fails and names the repeated angle", () => {
    const duplicated: Hook[] = [
      ...fixtureHooks.slice(0, 2),
      { ...fixtureHooks[0]!, text: "A reworded version of the first hook." },
    ];
    const result = checkHookDistinctiveness(duplicated);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("contrarian");
  });
});

describe("checkSectionCompleteness", () => {
  it("passes on a script with hook, body and CTA", () => {
    expect(checkSectionCompleteness(groundedScript).passed).toBe(true);
  });

  it("fails when the CTA is missing", () => {
    const noCta: Script = {
      ...groundedScript,
      sections: groundedScript.sections.filter((section) => section.kind !== "cta"),
    };
    const result = checkSectionCompleteness(noCta);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("cta");
  });

  it("treats a whitespace-only section as absent", () => {
    const blankBody: Script = {
      ...groundedScript,
      sections: groundedScript.sections.map((section) =>
        section.kind === "body" ? { ...section, text: "   " } : section,
      ),
    };
    expect(checkSectionCompleteness(blankBody).passed).toBe(false);
  });
});

describe("checkBannedPhrases", () => {
  const banned = ["game changer", "Let's dive in", "no excuses"];

  it("passes when the output avoids them", () => {
    expect(checkBannedPhrases(fixtureHooks, groundedScript, banned).passed).toBe(true);
  });

  it("catches a banned phrase in the script regardless of casing or punctuation", () => {
    const offending: Script = {
      ...groundedScript,
      sections: groundedScript.sections.map((section) =>
        section.kind === "cta"
          ? { ...section, text: "No excuses! Put the two sessions in the calendar." }
          : section,
      ),
    };
    const result = checkBannedPhrases(fixtureHooks, offending, banned);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("no excuses");
    expect(result.details).toContain("cta");
  });

  it("catches a banned phrase in a hook", () => {
    const offending: Hook[] = [
      { ...fixtureHooks[0]!, text: "This one change is a total game changer." },
      ...fixtureHooks.slice(1),
    ];
    const result = checkBannedPhrases(offending, groundedScript, banned);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("hook 1");
  });

  it("passes vacuously when the profile bans nothing", () => {
    expect(checkBannedPhrases(fixtureHooks, groundedScript, []).passed).toBe(true);
  });
});

describe("extractNumbers", () => {
  it("finds digits, percentages and currency amounts", () => {
    expect(extractNumbers("73% of lifters spend $2,400 across 45 minutes")).toEqual([
      "73%",
      "$2,400",
      "45",
    ]);
  });

  it("ignores numbers written as words", () => {
    expect(extractNumbers("two sessions a week for six weeks")).toEqual([]);
  });
});

describe("extractCapitalisedEntities", () => {
  it("finds multi-word capitalised names", () => {
    expect(
      extractCapitalisedEntities("Researchers at the Stanford Sleep Lab disagree."),
    ).toEqual(["Stanford Sleep Lab"]);
  });

  it("does not treat a sentence-opening word as part of a name", () => {
    expect(extractCapitalisedEntities("Strip the weight. Keep the tempo.")).toEqual([]);
    expect(extractCapitalisedEntities("Two sessions a week is enough.")).toEqual([]);
  });

  it("ignores single capitalised words and the pronoun I", () => {
    expect(extractCapitalisedEntities("Honestly I still cannot do one.")).toEqual([]);
  });
});

describe("checkGroundedness", () => {
  it("passes on the shipped fixtures, which are written against the sample idea", () => {
    const result = checkGroundedness(fixtureHooks, groundedScript, SAMPLE_IDEA);
    // Asserting on details too, so a regression says *what* was flagged.
    expect(result.details).toContain("no unsupported numbers");
    expect(result.passed).toBe(true);
  });

  /**
   * The load-bearing test of this file. A generator that pads a thin idea with
   * invented statistics and institutions is the failure mode the whole
   * grounding design exists to prevent, so the check must actually fire on one.
   */
  it("fails the deliberately-ungrounded fixture and names every violation", () => {
    const result = checkGroundedness(fixtureHooks, ungroundedScript, SAMPLE_IDEA);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);

    const violations = findGroundednessViolations(
      fixtureHooks,
      ungroundedScript,
      SAMPLE_IDEA,
    );
    const values = violations.map((violation) => violation.value);

    // An invented percentage, in the spoken line and again on screen.
    expect(values).toContain("73%");
    // An invented duration and an invented currency amount.
    expect(values).toContain("45");
    expect(values).toContain("$2,400");
    // An invented institution.
    expect(values).toContain("Stanford Sleep Lab");
    // A claim attributed to a span the idea does not contain.
    expect(values).toContain('"a longitudinal study of first-year lifters"');

    // ...but the one claim that *does* quote the idea is not flagged.
    expect(values).not.toContain(
      '"why two sessions a week beats a five-day split you abandon by week three"',
    );
  });

  it("accepts a number that the idea itself supplies", () => {
    const idea = "I want to talk about the 3 sets that actually matter.";
    const script: Script = {
      sections: [
        { kind: "hook", text: "Only 3 sets matter." },
        { kind: "body", text: "You do 3 sets and you go home." },
        { kind: "cta", text: "Try it this week." },
      ],
      claims: [{ text: "Three sets is enough.", grounded_in: "the 3 sets that actually matter" }],
    };
    expect(checkGroundedness([], script, idea).passed).toBe(true);
  });

  it("flags an invented number in on-screen text, not just in the spoken line", () => {
    const script: Script = {
      sections: [
        { kind: "hook", text: "Two sessions a week is enough.", on_screen_text: "90% agree" },
        { kind: "body", text: "That is the whole method." },
        { kind: "cta", text: "Pick your two days." },
      ],
      claims: [],
    };
    const result = checkGroundedness([], script, SAMPLE_IDEA);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("on-screen text");
  });
});

describe("runLayer1Checks", () => {
  it("returns all five dimensions in a stable order", () => {
    const checks = runLayer1Checks({
      idea: SAMPLE_IDEA,
      hooks: fixtureHooks,
      script: groundedScript,
      hookCount: 5,
      bannedPhrases: [],
    });

    expect(checks.map((check) => check.name)).toEqual([
      "hook_count",
      "hook_distinctiveness",
      "banned_phrases",
      "section_completeness",
      "groundedness",
    ]);
    expect(checks.every((check) => check.passed)).toBe(true);
  });
});
