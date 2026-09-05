import { describe, expect, it } from "vitest";

import {
  isClaimUnverified,
  renderScriptForClipboard,
} from "@/components/generate/script-text.ts";
import { MIN_IDEA_LENGTH as PIPELINE_MIN } from "@/lib/generate/pipeline.ts";
import { MIN_IDEA_LENGTH as IDEA_MIN } from "@/lib/generate/idea.ts";
import { GenerateRequestSchema, HOOK_COUNT_OPTIONS } from "@/types/api.ts";
import { MAX_HOOKS, MIN_HOOKS, type Script } from "@/types/generation.ts";

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
