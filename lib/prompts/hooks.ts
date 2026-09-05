import type { StructuredRequest } from "../llm/types.ts";
import type { VoiceProfile } from "../../types/voice.ts";
import {
  HOOK_ANGLES,
  HOOK_ANGLE_BRIEFS,
  MAX_HOOKS,
  MIN_HOOKS,
  hooksResultSchema,
  type Hook,
  type HooksResult,
} from "../../types/generation.ts";
import {
  buildVoiceSystemBlocks,
  renderBannedReminder,
  renderSteer,
  renderVoiceReminder,
} from "./system.ts";

/** Call 1 of the pipeline: N hook options, each on a different angle. */

export class HookRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookRequestError";
  }
}

/**
 * The mock adapter keys its fixtures off `kind`, and the requested hook count
 * changes the schema (exactly N items), so the count is part of the kind. A
 * `hooks` fixture holding five hooks cannot satisfy a request for three.
 */
export function hooksRequestKind(hookCount: number): string {
  return `hooks-${hookCount}`;
}

export function assertHookCount(hookCount: number): number {
  if (!Number.isInteger(hookCount) || hookCount < MIN_HOOKS || hookCount > MAX_HOOKS) {
    throw new HookRequestError(
      `hookCount must be a whole number between ${MIN_HOOKS} and ${MAX_HOOKS}; got ${hookCount}. The ceiling is the number of hook angles — every hook must take a different one, so there is no way to produce more hooks than there are angles.`,
    );
  }
  return hookCount;
}

function renderAngleMenu(): string {
  return HOOK_ANGLES.map((angle) => `  - ${angle}: ${HOOK_ANGLE_BRIEFS[angle]}`).join("\n");
}

/**
 * Task instructions for the hooks call.
 *
 * Stable for a given hook count, so it is cacheable — the creator's idea is not
 * in here, it goes in the user turn below.
 */
export function renderHooksInstructions(
  hookCount: number,
  profile: VoiceProfile,
): string {
  const banned = renderBannedReminder(profile.traits);
  const lines: (string | null)[] = [
    `TASK: write exactly ${hookCount} opening hooks for one Instagram Reel.`,
    "",
    "A hook is the first line said to camera. It has about two seconds to earn the third.",
    "",
    `Each hook takes a different ANGLE, chosen from this closed list:`,
    renderAngleMenu(),
    "",
    `All ${hookCount} angles must be DIFFERENT from each other. Do not return two hooks on the same angle, and do not return the same hook reworded — these are meant to be genuinely different ways in, so the creator can pick one. If an angle does not fit this idea, pick a different angle from the list rather than forcing it.`,
    "",
    `Use "stat_or_fact" only if the creator's idea already contains a number or a concrete fact you can lead with. If it does not, choose another angle. Do not invent a statistic to fill that slot — this is the most common way a hook generator puts a false claim in someone's mouth.`,
    "",
    "Every hook must be sayable out loud in one breath, in this creator's voice.",
    renderVoiceReminder(profile.traits),
    banned || null,
    "",
    "For each hook also give a one-sentence `rationale`: why this angle works for this specific idea. Write it for the creator choosing between options, not as praise for your own line.",
    "",
    "GROUNDING: every hook stays inside what the creator supplied. No number, statistic, percentage, study, brand, person or place that is not in their idea.",
  ];

  // `null` is the absent banned-phrase line only — real blank lines survive.
  return lines.filter((line) => line !== null).join("\n");
}

/**
 * The hooks the creator has already seen and rejected, handed back as explicit
 * avoid-context.
 *
 * Without this, "regenerate hooks" is a reshuffle: the same idea, the same
 * profile and the same angle menu produce the same neighbourhood of lines, and
 * round two reads as round one reworded. The rejected set is per-request, so it
 * goes in the user turn — never in a cacheable block.
 *
 * The angles are named alongside the text on purpose. "Do not repeat these"
 * reads to a model as "avoid these words"; naming the angle each rejected hook
 * took says the more useful thing, which is that the *approach* was tried.
 */
export function renderAvoidHooks(hooks: readonly Hook[]): string {
  if (hooks.length === 0) return "";

  const rendered = hooks
    .map((hook, index) => `${index + 1}. [${hook.angle}] ${hook.text}`)
    .join("\n");

  return [
    "<already_shown>",
    rendered,
    "</already_shown>",
    "I have already seen those and did not want them. Write genuinely different hooks: new openings, new framings, different sentences. Reusing an angle from that list is fine — rewording a line from it is not. If a line you are about to write is a paraphrase of one above, throw it out and find another way in.",
  ].join("\n");
}

export interface HooksRequestInput {
  idea: string;
  profile: VoiceProfile;
  hookCount: number;
  /** Previously-shown hooks to write away from. Regeneration only. */
  avoid?: readonly Hook[];
  /** The creator's optional one-line adjustment. Regeneration only. */
  steer?: string;
}

export function buildHooksRequest(
  input: HooksRequestInput,
): StructuredRequest<HooksResult> {
  const hookCount = assertHookCount(input.hookCount);
  const idea = input.idea.trim();

  // Everything below the system blocks is per-request. The order is the order
  // the model reads it in: the brief, then what was rejected, then the nudge.
  const userTurn = [
    `Here is my raw idea for this Reel. Write the ${hookCount} hooks.`,
    `<idea>\n${idea}\n</idea>`,
    renderAvoidHooks(input.avoid ?? []),
    renderSteer(input.steer),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

  return {
    kind: hooksRequestKind(hookCount),
    system: [
      ...buildVoiceSystemBlocks(input.profile),
      // Stable for this creator and this count; still no per-request content.
      // The avoid list and the steer are deliberately absent from here — either
      // one in a cacheable block invalidates the prefix on every regeneration.
      { text: renderHooksInstructions(hookCount, input.profile), cacheable: true },
    ],
    messages: [
      {
        // After the last cache breakpoint, which is the whole reason the idea
        // lives in the user turn rather than in the system prompt.
        role: "user",
        content: userTurn,
      },
    ],
    schema: hooksResultSchema(hookCount),
    schemaName: "hooks",
    maxTokens: 2048,
    effort: "high",
  };
}
