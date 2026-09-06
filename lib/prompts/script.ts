import type { StructuredRequest } from "../llm/types.ts";
import type { VoiceProfile, VoiceTraits } from "../../types/voice.ts";
import {
  SECTION_BRIEFS,
  SECTION_KINDS,
  ScriptSchema,
  type Hook,
  type Script,
  type SectionKind,
} from "../../types/generation.ts";
import {
  buildVoiceSystemBlocks,
  renderBannedReminder,
  renderSteer,
  renderVoiceReminder,
} from "./system.ts";

/**
 * Call 2 of the pipeline: the full sectioned script, conditioned on the idea,
 * the profile, and the hooks produced by call 1.
 *
 * This is the higher-risk half of the loop. Instruction drift is worse for
 * longer outputs, and a Reel script is several times the length of a hook — so
 * the voice reminder is repeated before *every* section instruction below
 * rather than stated once at the top, and the grounding rule is repeated at the
 * point where fabrication actually happens (the body).
 */

export const SCRIPT_KIND = "script";

/**
 * Per-section instructions, each one preceded by the compact voice reminder.
 *
 * The repetition is the point. Do not "clean this up" by hoisting the reminder
 * to the top of the prompt — that is the exact failure mode this shape exists
 * to prevent.
 */
export function renderSectionInstructions(traits: VoiceTraits): string {
  const reminder = renderVoiceReminder(traits);

  const extras: Partial<Record<SectionKind, string>> = {
    hook: "Use the hook the creator will most likely pick from the list above, or a tightened version of one of them. Do not invent a seventh direction here.",
    body: "This is where invented detail creeps in. Every sentence must trace back to the idea. If you find yourself reaching for a statistic, a study, a brand name or a round number to make a point land, the point is not supported — make it without them, or cut it.",
    payoff: "No summary of what you just said. Say what is different for them now.",
    cta: "One ask. Specific. In their register, not a marketing register.",
  };

  return SECTION_KINDS.map((kind, index) => {
    const extra = extras[kind];
    return [
      `SECTION ${index + 1} — ${kind}`,
      reminder,
      `  ${SECTION_BRIEFS[kind]}`,
      extra ? `  ${extra}` : null,
    ]
      .filter((line) => line !== null)
      .join("\n");
  }).join("\n\n");
}

/** Task instructions for the script call. Stable per creator; cacheable. */
export function renderScriptInstructions(profile: VoiceProfile): string {
  const banned = renderBannedReminder(profile.traits);

  const lines: (string | null)[] = [
    "TASK: write the full script for one Instagram Reel, in sections.",
    "",
    `Produce these ${SECTION_KINDS.length} sections, in this order, one entry each: ${SECTION_KINDS.join(", ")}.`,
    "Each section carries the words that are actually spoken. Optionally add `on_screen_text`: a short burned-in caption for that section, readable at a glance on a phone. Leave it out rather than padding it.",
    "",
    renderSectionInstructions(profile.traits),
    "",
    "GROUNDING — the rule that overrides making the script better:",
    "You are elaborating the creator's idea, not researching it. Structure, framing, pacing and transitions are yours to add. Facts are not. Do not introduce a statistic, a percentage, a currency amount, a duration, a study, a named person, a named brand, a named place, or any number that is not already in their idea.",
    "If the idea is thin, the script gets shorter. It does not get padded with invented support.",
    "",
    "For every factual assertion the script makes, add an entry to `claims`:",
    "  - `text`: the assertion, as the script states it.",
    "  - `grounded_in`: the span of the creator's idea it comes from, quoted VERBATIM. Copy the words from their idea exactly — do not paraphrase, do not summarise, do not stitch together words from different parts of it.",
    "If you cannot quote a span for an assertion, that assertion does not belong in the script. Remove it and write the section without it.",
    "Pure framing, transitions and the CTA are not claims and do not need entries.",
    banned || null,
  ];

  return lines.filter((line) => line !== null).join("\n");
}

/** The hooks from call 1, handed to call 2 as context. */
export function renderHooksContext(hooks: readonly Hook[]): string {
  const rendered = hooks
    .map((hook, index) => `${index + 1}. [${hook.angle}] ${hook.text}`)
    .join("\n");
  return `<hook_options>\n${rendered}\n</hook_options>`;
}

export interface ScriptRequestInput {
  idea: string;
  profile: VoiceProfile;
  hooks: readonly Hook[];
  /** The creator's optional one-line adjustment. Regeneration only. */
  steer?: string;
}

export function buildScriptRequest(
  input: ScriptRequestInput,
): StructuredRequest<Script> {
  const idea = input.idea.trim();

  return {
    kind: SCRIPT_KIND,
    system: [
      // Byte-identical to the hooks call's prefix, so call 2 reads call 1's cache.
      ...buildVoiceSystemBlocks(input.profile),
      { text: renderScriptInstructions(input.profile), cacheable: true },
    ],
    messages: [
      {
        // Everything per-request lives here, after the last cache breakpoint:
        // the idea and the hooks call 1 just produced.
        role: "user",
        content: [
          "Here is my raw idea for this Reel, and the hook options you just wrote for it. Write the full script.",
          `<idea>\n${idea}\n</idea>`,
          renderHooksContext(input.hooks),
          // Last, and only ever here: a steer in a cacheable block would cost
          // the whole voice prefix's cache hit on every regeneration.
          renderSteer(input.steer),
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
      },
    ],
    schema: ScriptSchema,
    schemaName: "reel_script",
    maxTokens: 4096,
    effort: "high",
  };
}
