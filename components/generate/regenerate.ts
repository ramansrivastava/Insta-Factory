import type {
  GenerateSuccessBody,
  RegenerateRequest,
  RegenerateSuccessBody,
} from "@/types/api.ts";
import {
  MAX_STEER_LENGTH,
  type Hook,
  type RegenerationTarget,
  type Script,
} from "@/types/generation.ts";

/**
 * The rules behind the Regenerate buttons, kept out of the component so they
 * can be unit tested without a renderer — same split as `./feedback.ts`.
 *
 * The load-bearing idea here is that the two halves on screen can come from
 * *different runs*. Regenerating the hooks does not touch the script, so after
 * one press the creator is looking at hooks from generation B beside a script
 * from generation A. The panel therefore tracks a generation id per half rather
 * than one for the pair: a hook rated "used as-is" has to attach to the run
 * that actually wrote it, or the accept/edit/discard data quietly starts
 * crediting the wrong generation.
 */

export interface OutputState {
  /** Normalised by the server. Claims are checked against this, not the textarea. */
  idea: string;
  hookCount: number;
  hooks: Hook[];
  /** The run that wrote the hooks now on screen. */
  hooksGenerationId: string;
  script: Script;
  /** The run that wrote the script now on screen. May differ from the hooks'. */
  scriptGenerationId: string;
  usedExampleProfile: boolean;
  profileWarnings: string[];
  /** The most recent run's numbers, for the footer. */
  latest: {
    generationId: string;
    provider: string;
    model: string;
    latencyMs: number;
    cacheReadTokens: number;
  };
}

export function outputStateFrom(body: GenerateSuccessBody): OutputState {
  return {
    idea: body.idea,
    hookCount: body.hookCount,
    hooks: body.hooks,
    hooksGenerationId: body.meta.generationId,
    script: body.script,
    scriptGenerationId: body.meta.generationId,
    usedExampleProfile: body.meta.usedExampleProfile,
    profileWarnings: body.meta.profileWarnings,
    latest: {
      generationId: body.meta.generationId,
      provider: body.meta.provider,
      model: body.meta.model,
      latencyMs: body.meta.latencyMs,
      cacheReadTokens: body.meta.cacheReadTokens,
    },
  };
}

/**
 * Folds a regeneration into what is on screen.
 *
 * Only the half the server actually re-ran is replaced. A response whose
 * regenerated half is missing changes nothing — better to leave the creator
 * looking at the output they had than to blank a panel on a malformed body.
 */
export function applyRegeneration(
  state: OutputState,
  body: RegenerateSuccessBody,
): OutputState {
  const latest = {
    generationId: body.meta.generationId,
    provider: body.meta.provider,
    model: body.meta.model,
    latencyMs: body.meta.latencyMs,
    cacheReadTokens: body.meta.cacheReadTokens,
  };

  if (body.target === "hooks") {
    if (!body.hooks) return state;
    return {
      ...state,
      hooks: body.hooks,
      hookCount: body.hooks.length,
      hooksGenerationId: body.meta.generationId,
      latest,
    };
  }

  if (!body.script) return state;
  return {
    ...state,
    script: body.script,
    scriptGenerationId: body.meta.generationId,
    latest,
  };
}

/**
 * The request body for one press of a Regenerate button.
 *
 * `parentGenerationId` is the run that wrote the half being replaced, not
 * whatever ran most recently. Regenerating the hooks twice and the script once
 * should read back as two chains, not one interleaved one.
 *
 * The hooks are sent either way and mean different things by target: rejected
 * hooks to write away from, or the hooks the new script must open with. Both
 * are "the hooks currently on screen", which is the only thing the client
 * actually knows.
 */
export function buildRegeneratePayload(
  state: OutputState,
  target: RegenerationTarget,
  steer: string,
): RegenerateRequest {
  const trimmed = steer.trim();
  return {
    target,
    idea: state.idea,
    hookCount: state.hookCount,
    parentGenerationId:
      target === "hooks" ? state.hooksGenerationId : state.scriptGenerationId,
    hooks: state.hooks,
    ...(trimmed ? { steer: trimmed } : {}),
  };
}

/** True when the steer is longer than the API will accept. */
export function isSteerTooLong(steer: string): boolean {
  return steer.trim().length > MAX_STEER_LENGTH;
}

/**
 * What to say when a regeneration came back with a failed Layer-1 gate.
 *
 * Shown rather than swallowed: the creator asked for this output *again*, and
 * "the second attempt invented a statistic too" is the single most useful thing
 * to tell them at that moment. Returns null when everything passed, so the
 * common case renders nothing.
 */
export function failedCheckSummary(
  checks: RegenerateSuccessBody["checks"],
): string | null {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) return null;
  return failed.map((check) => `${check.name}: ${check.details}`).join(" · ");
}
