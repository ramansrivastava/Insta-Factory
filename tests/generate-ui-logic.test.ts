import { describe, expect, it } from "vitest";

import {
  buildFeedbackPayload,
  isEditEmpty,
  isEditTooLong,
} from "@/components/generate/feedback.ts";
import {
  applyRegeneration,
  buildRegeneratePayload,
  failedCheckSummary,
  isSteerTooLong,
  type OutputState,
} from "@/components/generate/regenerate.ts";
import {
  isClaimUnverified,
  renderScriptForClipboard,
} from "@/components/generate/script-text.ts";
import { MIN_IDEA_LENGTH as PIPELINE_MIN } from "@/lib/generate/pipeline.ts";
import { MIN_IDEA_LENGTH as IDEA_MIN } from "@/lib/generate/idea.ts";
import {
  GenerateRequestSchema,
  HOOK_COUNT_OPTIONS,
  RegenerateRequestSchema,
  type RegenerateSuccessBody,
} from "@/types/api.ts";
import { FeedbackRequestSchema, MAX_EDITED_TEXT_LENGTH } from "@/types/feedback.ts";
import {
  MAX_HOOKS,
  MAX_STEER_LENGTH,
  MIN_HOOKS,
  type Script,
} from "@/types/generation.ts";

/**
 * The pure logic behind the output view. Rendering is left to a browser; what
 * is worth pinning is the rule that decides whether a claim gets the
 * "unverified claim" marker, because that marker is the visible half of the
 * hallucination mitigation.
 */

const idea =
  "Two sessions a week beats a five-day split you abandon by week three, and here is how I run mine.";

describe("isClaimUnverified", () => {
  it("accepts a claim whose quoted span really is in the idea", () => {
    expect(
      isClaimUnverified(
        { text: "Consistency beats volume.", grounded_in: "two sessions a week" },
        idea,
      ),
    ).toBe(false);
  });

  it("ignores case and punctuation when matching the span", () => {
    expect(
      isClaimUnverified(
        { text: "Consistency beats volume.", grounded_in: "Five-day split!" },
        idea,
      ),
    ).toBe(false);
  });

  it("flags a claim attributed to a span the creator never wrote", () => {
    expect(
      isClaimUnverified(
        {
          text: "Eighty percent of lifters quit by week six.",
          grounded_in: "eighty percent of lifters quit",
        },
        idea,
      ),
    ).toBe(true);
  });

  it("flags a claim with a blank attribution", () => {
    expect(isClaimUnverified({ text: "Some claim.", grounded_in: "   " }, idea)).toBe(true);
  });
});

describe("renderScriptForClipboard", () => {
  it("copies every section in order, with its label and its on-screen text", () => {
    const script: Script = {
      sections: [
        { kind: "hook", text: "Stop programming for a life you do not have.", on_screen_text: "STOP" },
        { kind: "body", text: "Two sessions. Every week. No exceptions." },
        { kind: "cta", text: "Tell me your two days." },
      ],
      claims: [],
    };

    const copied = renderScriptForClipboard(script);

    expect(copied).toContain("HOOK\nStop programming for a life you do not have.");
    expect(copied).toContain("[on screen: STOP]");
    expect(copied).toContain("CTA\nTell me your two days.");
    expect(copied.indexOf("HOOK")).toBeLessThan(copied.indexOf("BODY"));
  });
});

describe("the API contract the UI is built against", () => {
  /**
   * `types/api.ts` cannot import the pipeline — that would drag the Anthropic
   * SDK into the browser bundle — so both read the bound from `lib/generate/
   * idea.ts`. This asserts that indirection actually holds.
   */
  it("shares one minimum idea length with the pipeline", () => {
    expect(IDEA_MIN).toBe(PIPELINE_MIN);
  });

  it("offers exactly the hook counts the pipeline accepts", () => {
    expect(HOOK_COUNT_OPTIONS).toEqual([3, 4, 5, 6]);
    expect(HOOK_COUNT_OPTIONS[0]).toBe(MIN_HOOKS);
    expect(HOOK_COUNT_OPTIONS.at(-1)).toBe(MAX_HOOKS);

    for (const hookCount of HOOK_COUNT_OPTIONS) {
      expect(
        GenerateRequestSchema.safeParse({ idea, hookCount }).success,
      ).toBe(true);
    }
  });

  it("trims the idea before measuring it", () => {
    const parsed = GenerateRequestSchema.safeParse({ idea: `   ${idea}   ` });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.idea).toBe(idea);
  });
});

describe("the feedback buttons' rules", () => {
  const subject = { generationId: "gen-1", target: "hook" as const, hookIndex: 0 };

  it("holds the edit back until there is a rewrite to send", () => {
    // The API refuses an `edited` outcome with no text, so the button that
    // would produce that request has to be disabled rather than fail.
    expect(isEditEmpty("")).toBe(true);
    expect(isEditEmpty("   \n ")).toBe(true);
    expect(isEditEmpty("What I said instead.")).toBe(false);
    expect(isEditTooLong("x".repeat(MAX_EDITED_TEXT_LENGTH + 1))).toBe(true);
  });

  it("attaches the rewrite only to an edited outcome", () => {
    expect(buildFeedbackPayload(subject, "edited", "  My version.  ")).toEqual({
      generationId: "gen-1",
      target: "hook",
      hookIndex: 0,
      outcome: "edited",
      editedText: "My version.",
    });
    expect(
      buildFeedbackPayload(subject, "discarded", "abandoned rewrite"),
    ).not.toHaveProperty("editedText");
  });

  it("builds a payload the API will accept", () => {
    const payload = buildFeedbackPayload(subject, "edited", "My version.");
    expect(FeedbackRequestSchema.safeParse(payload).success).toBe(true);
  });
});

/**
 * The Regenerate buttons' rules.
 *
 * The one that matters is per-half provenance. After "Regenerate hooks" the
 * panel is showing hooks from run B beside a script from run A, and a hook
 * rated "used as-is" has to attach to B while the script's rating still
 * attaches to A — otherwise the accept/edit/discard data starts crediting the
 * wrong generation, silently and unrecoverably.
 */
describe("the regenerate buttons' rules", () => {
  const base: OutputState = {
    idea,
    hookCount: 3,
    hooks: [
      { text: "Hook one.", angle: "contrarian", rationale: "why one" },
      { text: "Hook two.", angle: "pain_point", rationale: "why two" },
      { text: "Hook three.", angle: "bold_claim", rationale: "why three" },
    ],
    hooksGenerationId: "gen-a",
    script: {
      sections: [
        { kind: "hook", text: "Opening line." },
        { kind: "body", text: "The middle." },
        { kind: "cta", text: "Follow for more." },
      ],
      claims: [],
    },
    scriptGenerationId: "gen-a",
    usedExampleProfile: false,
    profileWarnings: [],
    latest: {
      generationId: "gen-a",
      provider: "mock",
      model: "mock-fixture-model",
      latencyMs: 12,
      cacheReadTokens: 0,
    },
  };

  function response(over: Partial<RegenerateSuccessBody>): RegenerateSuccessBody {
    return {
      ok: true,
      target: "hooks",
      idea,
      hookCount: 3,
      hooks: null,
      script: null,
      checks: [],
      meta: {
        generationId: "gen-b",
        provider: "mock",
        model: "mock-fixture-model",
        cacheReadTokens: 900,
        latencyMs: 20,
        parentGenerationId: "gen-a",
        usedExampleProfile: false,
        profileWarnings: [],
      },
      ...over,
    };
  }

  it("names the run that wrote the half being replaced, not the most recent one", () => {
    const mixed: OutputState = { ...base, hooksGenerationId: "gen-b" };
    expect(buildRegeneratePayload(mixed, "hooks", "").parentGenerationId).toBe("gen-b");
    expect(buildRegeneratePayload(mixed, "script", "").parentGenerationId).toBe("gen-a");
  });

  it("sends the hooks on screen either way, and the steer only when there is one", () => {
    expect(buildRegeneratePayload(base, "hooks", "  ")).not.toHaveProperty("steer");
    const steered = buildRegeneratePayload(base, "script", "  lead with the mistake  ");
    expect(steered.steer).toBe("lead with the mistake");
    expect(steered.hooks).toEqual(base.hooks);
  });

  it("builds a payload the API will accept", () => {
    expect(
      RegenerateRequestSchema.safeParse(buildRegeneratePayload(base, "hooks", "blunter"))
        .success,
    ).toBe(true);
    expect(isSteerTooLong("x".repeat(MAX_STEER_LENGTH + 1))).toBe(true);
    expect(isSteerTooLong(`  ${"x".repeat(MAX_STEER_LENGTH)}  `)).toBe(false);
  });

  it("moves only the regenerated half, and re-points only that half's trace id", () => {
    const newHooks = [{ text: "Fresh.", angle: "curiosity_gap" as const, rationale: "why" }];
    const afterHooks = applyRegeneration(base, response({ hooks: newHooks }));

    expect(afterHooks.hooks).toEqual(newHooks);
    expect(afterHooks.hookCount).toBe(1);
    expect(afterHooks.hooksGenerationId).toBe("gen-b");
    expect(afterHooks.script).toBe(base.script);
    expect(afterHooks.scriptGenerationId).toBe("gen-a");
    expect(afterHooks.latest.cacheReadTokens).toBe(900);

    const newScript: Script = { sections: base.script.sections, claims: [] };
    const afterScript = applyRegeneration(
      base,
      response({ target: "script", script: newScript }),
    );
    expect(afterScript.scriptGenerationId).toBe("gen-b");
    expect(afterScript.hooksGenerationId).toBe("gen-a");
    expect(afterScript.hooks).toBe(base.hooks);
  });

  it("leaves the screen alone when the regenerated half is missing from the body", () => {
    expect(applyRegeneration(base, response({ hooks: null }))).toBe(base);
    expect(applyRegeneration(base, response({ target: "script", script: null }))).toBe(base);
  });

  it("says which gate the second attempt failed, and nothing when they all passed", () => {
    expect(failedCheckSummary([{ name: "groundedness", passed: true, score: 1, details: "ok" }]))
      .toBeNull();
    expect(
      failedCheckSummary([
        { name: "groundedness", passed: false, score: 0, details: "invented a number" },
      ]),
    ).toContain("invented a number");
  });
});
