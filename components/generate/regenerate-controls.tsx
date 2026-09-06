"use client";

import { useState } from "react";

import { MAX_STEER_LENGTH, type RegenerationTarget } from "@/types/generation.ts";

import { isSteerTooLong } from "./regenerate.ts";

/**
 * "Regenerate hooks" / "Regenerate script", with one optional line of steer.
 *
 * One line, not a prompt box. The failure this exists to fix is "close, but not
 * quite" — the creator liked the direction and wants one thing changed — and a
 * larger box invites rewriting the brief, which is a different product. The
 * cap is enforced here as well as server-side so the button explains itself
 * before the round trip.
 *
 * The steer is the *only* thing the creator adds, and it is appended to the
 * user turn after the cacheable voice prefix, so pressing this repeatedly stays
 * cheap. That is a server-side property (`renderSteer` in
 * `lib/prompts/system.ts`); it is noted here because it is the reason this
 * control is a text input and not a full prompt editor.
 */
export function RegenerateControls({
  target,
  busy,
  disabled,
  error,
  onRegenerate,
}: {
  target: RegenerationTarget;
  busy: boolean;
  /** True while the *other* half is regenerating — one call at a time. */
  disabled: boolean;
  error: string | null;
  onRegenerate: (steer: string) => void;
}) {
  const [steer, setSteer] = useState("");

  const tooLong = isSteerTooLong(steer);
  const noun = target === "hooks" ? "hooks" : "script";
  const inputId = `steer-${target}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Optional adjustment for the new {noun}
        </label>
        <input
          id={inputId}
          type="text"
          value={steer}
          onChange={(event) => setSteer(event.target.value)}
          disabled={busy || disabled}
          placeholder={
            target === "hooks"
              ? "Optional: make them blunter"
              : "Optional: lead with the mistake"
          }
          className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => onRegenerate(steer)}
          disabled={busy || disabled || tooLong}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
        >
          {busy ? "Rewriting…" : `Regenerate ${noun}`}
        </button>
      </div>

      {tooLong ? (
        <p className="text-xs text-amber-300/90">
          That is {steer.trim().length} characters — a steer is one line, up to{" "}
          {MAX_STEER_LENGTH}. Anything longer belongs in the idea itself.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
