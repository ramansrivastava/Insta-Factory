import type { StructuredRequest } from "../llm/types.ts";
import type { VoiceProfile } from "../../types/voice.ts";
import {
  HOOK_ANGLES,
  HOOK_ANGLE_BRIEFS,
  MAX_HOOKS,
  MIN_HOOKS,
  hooksResultSchema,
  type HooksResult,
} from "../../types/generation.ts";
import {
  buildVoiceSystemBlocks,
  renderBannedReminder,
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

export interface HooksRequestInput {
  idea: string;
  profile: VoiceProfile;
  hookCount: number;
}

export function buildHooksRequest(
  input: HooksRequestInput,
): StructuredRequest<HooksResult> {
  const hookCount = assertHookCount(input.hookCount);
  const idea = input.idea.trim();

  return {
    kind: hooksRequestKind(hookCount),
    system: [
      ...buildVoiceSystemBlocks(input.profile),
      // Stable for this creator and this count; still no per-request content.
      { text: renderHooksInstructions(hookCount, input.profile), cacheable: true },
    ],
    messages: [
      {
        // After the last cache breakpoint, which is the whole reason the idea
        // lives in the user turn rather than in the system prompt.
        role: "user",
        content: `Here is my raw idea for this Reel. Write the ${hookCount} hooks.\n\n<idea>\n${idea}\n</idea>`,
      },
    ],
    schema: hooksResultSchema(hookCount),
    schemaName: "hooks",
    maxTokens: 2048,
    effort: "high",
  };
}
