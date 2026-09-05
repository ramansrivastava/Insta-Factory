import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertHookCount,
  buildHooksRequest,
  hooksRequestKind,
  renderAvoidHooks,
  HookRequestError,
} from "@/lib/prompts/hooks.ts";
import { buildScriptRequest, renderSectionInstructions } from "@/lib/prompts/script.ts";
import {
  buildVoiceSystemBlocks,
  renderSteer,
  renderTraits,
  renderVoiceReminder,
} from "@/lib/prompts/system.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import { SECTION_KINDS, MAX_HOOKS, type Hook } from "@/types/generation.ts";
import { VoiceProfileSchema, type VoiceProfile } from "@/types/voice.ts";

const profile: VoiceProfile = VoiceProfileSchema.parse(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "data/voice-profile.example.json"), "utf8"),
  ),
);

const hooks: Hook[] = (
  JSON.parse(
    readFileSync(path.join(process.cwd(), "fixtures/llm/hooks-5.json"), "utf8"),
  ) as { hooks: Hook[] }
).hooks;

describe("renderTraits", () => {
  it("renders every trait the profile carries", () => {
    const rendered = renderTraits(profile.traits);
    expect(rendered).toContain(profile.traits.tone);
    expect(rendered).toContain(profile.traits.sentence_rhythm);
    expect(rendered).toContain(`vocabulary_register: ${profile.traits.vocabulary_register}`);
    for (const phrase of profile.traits.banned_phrases) {
      expect(rendered).toContain(phrase);
    }
  });

  it("is byte-stable for the same profile, so the cache prefix holds", () => {
    expect(renderTraits(profile.traits)).toBe(renderTraits(profile.traits));
  });
});

describe("buildVoiceSystemBlocks", () => {
  it("marks every block cacheable", () => {
    const blocks = buildVoiceSystemBlocks(profile);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((block) => block.cacheable === true)).toBe(true);
  });

  it("never leaks the profile timestamp into the cacheable prefix", () => {
    const joined = buildVoiceSystemBlocks(profile)
      .map((block) => block.text)
      .join("\n");
    expect(joined).not.toContain(profile.updated_at);
    expect(joined).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("buildHooksRequest", () => {
  it("puts the idea in the user turn, after the last cache breakpoint", () => {
    const request = buildHooksRequest({ idea: SAMPLE_IDEA, profile, hookCount: 5 });

    for (const block of request.system) {
      expect(block.text).not.toContain(SAMPLE_IDEA);
      expect(block.cacheable).toBe(true);
    }
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.role).toBe("user");
    expect(request.messages[0]!.content).toContain(SAMPLE_IDEA);
  });

  it("states the requested count and that the angles must differ", () => {
    const instructions = buildHooksRequest({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 4,
    }).system.at(-1)!.text;

    expect(instructions).toContain("exactly 4 opening hooks");
    expect(instructions).toContain("must be DIFFERENT");
    expect(instructions).toContain("curiosity_gap");
    expect(instructions).toContain("story_cold_open");
  });

  it("states the grounding constraint", () => {
    const instructions = buildHooksRequest({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
    }).system.at(-1)!.text;
    expect(instructions).toContain("GROUNDING");
    expect(instructions).toMatch(/not in their idea/);
  });

  it("requires exactly N hooks in the schema, not merely at most N", () => {
    const request = buildHooksRequest({ idea: SAMPLE_IDEA, profile, hookCount: 3 });
    expect(request.schema.safeParse({ hooks: hooks.slice(0, 3) }).success).toBe(true);
    expect(request.schema.safeParse({ hooks: hooks.slice(0, 2) }).success).toBe(false);
    expect(request.schema.safeParse({ hooks }).success).toBe(false);
  });

  it("keys the fixture kind by hook count, since the count changes the schema", () => {
    expect(hooksRequestKind(3)).toBe("hooks-3");
    expect(buildHooksRequest({ idea: SAMPLE_IDEA, profile, hookCount: 6 }).kind).toBe(
      "hooks-6",
    );
  });

  it("rejects a hook count above the number of available angles", () => {
    expect(() => assertHookCount(MAX_HOOKS + 1)).toThrow(HookRequestError);
    expect(() => assertHookCount(1)).toThrow(HookRequestError);
    expect(() => assertHookCount(4.5)).toThrow(HookRequestError);
  });

  it("sends no sampling parameters", () => {
    const request = buildHooksRequest({ idea: SAMPLE_IDEA, profile, hookCount: 5 });
    expect(request.samplingHints).toBeUndefined();
  });
});

describe("buildScriptRequest", () => {
  /**
   * The instruction-drift guard. Stating the voice once at the top of a long
   * prompt is the documented way this product goes generic — if someone hoists
   * the reminder out of the section loop, this fails.
   */
  it("re-injects the voice reminder before every section instruction", () => {
    const reminder = renderVoiceReminder(profile.traits);
    const rendered = renderSectionInstructions(profile.traits);
    const occurrences = rendered.split(reminder).length - 1;
    expect(occurrences).toBe(SECTION_KINDS.length);
  });

  it("names every section kind in order", () => {
    const instructions = buildScriptRequest({ idea: SAMPLE_IDEA, profile, hooks })
      .system.at(-1)!
      .text;
    const positions = SECTION_KINDS.map((kind) => instructions.indexOf(`— ${kind}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("requires grounded_in to quote the idea verbatim", () => {
    const instructions = buildScriptRequest({ idea: SAMPLE_IDEA, profile, hooks })
      .system.at(-1)!
      .text;
    expect(instructions).toContain("grounded_in");
    expect(instructions).toContain("VERBATIM");
  });

  it("passes the hooks from call 1 in the user turn, alongside the idea", () => {
    const request = buildScriptRequest({ idea: SAMPLE_IDEA, profile, hooks });
    const userTurn = request.messages[0]!.content;

    expect(userTurn).toContain(SAMPLE_IDEA);
    for (const hook of hooks) {
      expect(userTurn).toContain(hook.text);
      expect(userTurn).toContain(hook.angle);
    }
    for (const block of request.system) {
      expect(block.text).not.toContain(hooks[0]!.text);
    }
  });

  it("opens with the same cacheable prefix as the hooks call", () => {
    const hooksRequest = buildHooksRequest({ idea: SAMPLE_IDEA, profile, hookCount: 5 });
    const scriptRequest = buildScriptRequest({ idea: SAMPLE_IDEA, profile, hooks });

    expect(scriptRequest.system.slice(0, 3).map((block) => block.text)).toEqual(
      hooksRequest.system.slice(0, 3).map((block) => block.text),
    );
  });

  it("sends no sampling parameters", () => {
    expect(
      buildScriptRequest({ idea: SAMPLE_IDEA, profile, hooks }).samplingHints,
    ).toBeUndefined();
  });
});

/**
 * Regeneration prompts.
 *
 * Two properties matter and neither is visible in the output: that the rejected
 * hooks actually reach the model, and that nothing per-request ever lands above
 * the last cache breakpoint. The second one has no failure mode you can see —
 * a steer in a cacheable block produces identical text and a silently doubled
 * bill — so it is asserted here rather than trusted.
 */
describe("renderAvoidHooks", () => {
  it("is empty for an empty list, so callers can append it unconditionally", () => {
    expect(renderAvoidHooks([])).toBe("");
  });

  it("names the angle beside each rejected line, not just the text", () => {
    const rendered = renderAvoidHooks(hooks);
    for (const hook of hooks) {
      expect(rendered).toContain(hook.text);
      expect(rendered).toContain(hook.angle);
    }
  });
});

describe("renderSteer", () => {
  it("is empty for an absent or blank steer", () => {
    expect(renderSteer(undefined)).toBe("");
    expect(renderSteer(null)).toBe("");
    expect(renderSteer("   ")).toBe("");
  });

  it("subordinates the steer to the voice profile and the grounding rule", () => {
    const rendered = renderSteer("make it blunter");
    expect(rendered).toContain("make it blunter");
    expect(rendered.toLowerCase()).toContain("voice profile");
  });
});

describe("buildHooksRequest on a regeneration", () => {
  it("passes the rejected hooks in the user turn and nowhere else", () => {
    const request = buildHooksRequest({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      avoid: hooks,
      steer: "make them blunter",
    });

    const userTurn = request.messages[0]!.content;
    for (const hook of hooks) {
      expect(userTurn).toContain(hook.text);
    }
    expect(userTurn).toContain("make them blunter");

    // The whole economics of the feature: the cacheable prefix must be
    // byte-identical to a first-pass request for the same creator and count.
    for (const block of request.system) {
      expect(block.text).not.toContain(hooks[0]!.text);
      expect(block.text).not.toContain("make them blunter");
    }
  });

  it("leaves the cacheable prefix byte-identical to the first-pass request", () => {
    const first = buildHooksRequest({ idea: SAMPLE_IDEA, profile, hookCount: 5 });
    const again = buildHooksRequest({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      avoid: hooks,
      steer: "lead with the mistake",
    });

    expect(again.system.map((block) => block.text)).toEqual(
      first.system.map((block) => block.text),
    );
    expect(again.kind).toBe(first.kind);
  });

  it("puts the steer after the rejected hooks, so it reads as the last word", () => {
    const userTurn = buildHooksRequest({
      idea: SAMPLE_IDEA,
      profile,
      hookCount: 5,
      avoid: hooks,
      steer: "shorter",
    }).messages[0]!.content;

    expect(userTurn.indexOf("<steer>")).toBeGreaterThan(userTurn.indexOf("<already_shown>"));
  });
});

describe("buildScriptRequest on a regeneration", () => {
  it("appends the steer to the user turn and leaves the prefix alone", () => {
    const first = buildScriptRequest({ idea: SAMPLE_IDEA, profile, hooks });
    const again = buildScriptRequest({
      idea: SAMPLE_IDEA,
      profile,
      hooks,
      steer: "lead with the mistake",
    });

    expect(again.messages[0]!.content).toContain("lead with the mistake");
    expect(again.system.map((block) => block.text)).toEqual(
      first.system.map((block) => block.text),
    );
    for (const block of again.system) {
      expect(block.text).not.toContain("lead with the mistake");
    }
  });
});
