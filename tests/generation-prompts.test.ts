import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertHookCount,
  buildHooksRequest,
  hooksRequestKind,
  HookRequestError,
} from "@/lib/prompts/hooks.ts";
import { buildScriptRequest, renderSectionInstructions } from "@/lib/prompts/script.ts";
import {
  buildVoiceSystemBlocks,
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
