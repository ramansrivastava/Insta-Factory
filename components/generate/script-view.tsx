import type { Claim, Script } from "@/types/generation.ts";

import { CopyButton } from "./copy-button.tsx";
import { FeedbackControls } from "./feedback-controls.tsx";
import {
  isClaimUnverified,
  renderScriptForClipboard,
  sectionLabel,
} from "./script-text.ts";

/**
 * The script, as labelled sections with their burned-in captions beside them,
 * plus the claims the script makes and where each one came from.
 *
 * The rules behind the "unverified claim" marker and the clipboard rendering
 * live in `./script-text.ts` so they can be unit tested without a renderer.
 */

export function ScriptView({
  script,
  idea,
  generationId,
}: {
  script: Script;
  idea: string;
  generationId: string;
}) {
  return (
    <section aria-labelledby="script-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="script-heading" className="text-lg font-semibold tracking-tight">
          Script
        </h2>
        <CopyButton
          text={renderScriptForClipboard(script)}
          label="Copy whole script"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <div className="grid grid-cols-[6rem_1fr_14rem] gap-px bg-zinc-800 text-sm">
          <div className="bg-zinc-900 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
            Section
          </div>
          <div className="bg-zinc-900 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
            Spoken
          </div>
          <div className="bg-zinc-900 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
            On screen
          </div>

          {script.sections.map((section, index) => (
            <div key={`${section.kind}-${index}`} className="contents">
              <div className="bg-zinc-950 px-3 py-3 font-medium text-zinc-400">
                {sectionLabel(section.kind)}
              </div>
              <div className="bg-zinc-950 px-3 py-3 leading-relaxed text-zinc-100">
                {section.text}
              </div>
              <div className="bg-zinc-950 px-3 py-3 text-zinc-400">
                {section.on_screen_text ? (
                  section.on_screen_text
                ) : (
                  <span className="text-zinc-600">&mdash;</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {script.claims.length > 0 ? <ClaimList claims={script.claims} idea={idea} /> : null}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="mb-2 text-sm text-zinc-400">
          Once you have recorded this: did you use the script as written?
        </p>
        <FeedbackControls
          subject={{ generationId, target: "script" }}
          label="this script"
        />
      </div>
    </section>
  );
}

function ClaimList({ claims, idea }: { claims: Claim[]; idea: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold tracking-tight text-zinc-300">
        Claims this script makes
      </h3>
      <ul className="flex flex-col gap-2">
        {claims.map((claim, index) => {
          const unverified = isClaimUnverified(claim, idea);
          return (
            <li
              key={index}
              className={`rounded-md border px-3 py-2 text-sm ${
                unverified
                  ? "border-amber-500/50 bg-amber-500/5"
                  : "border-zinc-800 bg-zinc-900/40"
              }`}
            >
              <p className="text-zinc-100">{claim.text}</p>
              {unverified ? (
                <p className="mt-1 flex flex-wrap items-center gap-2 text-amber-300">
                  <span className="rounded-full border border-amber-500/60 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide">
                    Unverified claim
                  </span>
                  <span className="text-xs">
                    Not traceable to anything you wrote &mdash; check it before you post.
                  </span>
                </p>
              ) : (
                <p className="mt-1 text-xs text-zinc-500">
                  From your idea: &ldquo;{claim.grounded_in}&rdquo;
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
