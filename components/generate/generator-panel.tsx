"use client";

import { useState } from "react";

import { MAX_IDEA_LENGTH, MIN_IDEA_LENGTH } from "@/lib/generate/idea.ts";
import {
  HOOK_COUNT_OPTIONS,
  type GenerateErrorBody,
  type GenerateSuccessBody,
  type RegenerateSuccessBody,
} from "@/types/api.ts";
import { DEFAULT_HOOK_COUNT, type RegenerationTarget } from "@/types/generation.ts";

import { HookList } from "./hook-list.tsx";
import {
  applyRegeneration,
  buildRegeneratePayload,
  failedCheckSummary,
  outputStateFrom,
  type OutputState,
} from "./regenerate.ts";
import { RegenerateControls } from "./regenerate-controls.tsx";
import { ScriptView } from "./script-view.tsx";

/**
 * The idea → output screen.
 *
 * Loading and failure are rendered states, not thrown exceptions: this is the
 * one screen of the product, a generation takes seconds and can fail four
 * distinct ways, and an error boundary that blanks the page would also throw
 * away the idea the creator just typed.
 *
 * Output lives here as an `OutputState` rather than as the response body,
 * because after a regeneration the two halves on screen come from two different
 * runs and the body has no way to say so. See `./regenerate.ts`.
 */

type Status = "idle" | "loading" | "done" | "error";

interface Failure {
  message: string;
  /** Shown as a small hint under the message when we know a next step. */
  hint: string | null;
}

/** Turns a non-2xx response into something worth reading. */
function describeFailure(status: number, body: GenerateErrorBody | null): Failure {
  if (body?.ok === false) {
    const { code, message, retryAfterSeconds } = body.error;
    if (code === "rate_limited") {
      return {
        message,
        hint:
          retryAfterSeconds === undefined
            ? "The provider did not say how long to wait."
            : `The provider asked for ${retryAfterSeconds}s.`,
      };
    }
    if (code === "bad_request") {
      return { message, hint: "Adjust the idea above and generate again." };
    }
    return { message, hint: null };
  }

  return {
    message: `The generator answered with HTTP ${status} and no explanation.`,
    hint: "That is a bug on our side — the server log will have the cause.",
  };
}

export function GeneratorPanel({
  provider,
  model,
}: {
  provider: string;
  model: string;
}) {
  const [idea, setIdea] = useState("");
  const [hookCount, setHookCount] = useState(DEFAULT_HOOK_COUNT);
  const [status, setStatus] = useState<Status>("idle");
  const [output, setOutput] = useState<OutputState | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Which half is being re-run, if any. One at a time: the two calls share a
  // voice profile and an idea, and letting them race would land two records
  // claiming the same parent.
  const [regenerating, setRegenerating] = useState<RegenerationTarget | null>(null);
  // Tagged with the half that failed, so a rate limit hit while rewriting the
  // script does not put a red line under the hooks too.
  const [regenerateFailure, setRegenerateFailure] = useState<
    { target: RegenerationTarget; failure: Failure } | null
  >(null);
  const [checkNote, setCheckNote] = useState<string | null>(null);

  const trimmed = idea.trim();
  const tooShort = trimmed.length < MIN_IDEA_LENGTH;
  const tooLong = trimmed.length > MAX_IDEA_LENGTH;
  const busy = status === "loading";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || tooShort || tooLong) return;

    setStatus("loading");
    setFailure(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: trimmed, hookCount }),
      });

      // A body that is not JSON is itself the failure signal — never let a
      // parse error escape as an unhandled rejection.
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok || (body as GenerateSuccessBody | null)?.ok !== true) {
        setFailure(describeFailure(response.status, body as GenerateErrorBody | null));
        setStatus("error");
        return;
      }

      setOutput(outputStateFrom(body as GenerateSuccessBody));
      setRegenerateFailure(null);
      setCheckNote(null);
      setStatus("done");
    } catch {
      setFailure({
        message: "Could not reach the generator.",
        hint: "Check that the dev server is still running, then try again.",
      });
      setStatus("error");
    }
  }

  async function onRegenerate(target: RegenerationTarget, steer: string) {
    if (!output || regenerating !== null) return;

    setRegenerating(target);
    setRegenerateFailure(null);
    setCheckNote(null);

    try {
      const response = await fetch("/api/regenerate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRegeneratePayload(output, target, steer)),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok || (body as RegenerateSuccessBody | null)?.ok !== true) {
        setRegenerateFailure({
          target,
          failure: describeFailure(response.status, body as GenerateErrorBody | null),
        });
        return;
      }

      const success = body as RegenerateSuccessBody;
      // Only the regenerated half moves. The other one, and the generation id
      // its feedback attaches to, are left exactly as they were.
      setOutput((current) => (current ? applyRegeneration(current, success) : current));
      setCheckNote(failedCheckSummary(success.checks));
    } catch {
      setRegenerateFailure({
        target,
        failure: {
          message: "Could not reach the generator.",
          hint: "Check that the dev server is still running, then try again.",
        },
      });
    } finally {
      setRegenerating(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="idea" className="text-sm font-medium text-zinc-300">
            Your raw idea
          </label>
          <textarea
            id="idea"
            name="idea"
            rows={5}
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            disabled={busy}
            placeholder="Two sessions a week beats a five-day split you abandon by week three — and here is how I actually run mine."
            className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-base leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
          />
          <p className="text-xs text-zinc-500">
            {tooLong
              ? `That is ${trimmed.length} characters — trim it to ${MAX_IDEA_LENGTH} or fewer.`
              : tooShort
                ? `${trimmed.length}/${MIN_IDEA_LENGTH} characters minimum. Write the point you want to make, not a title.`
                : `${trimmed.length} characters. The script elaborates on this and adds nothing that is not here.`}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="hookCount" className="text-sm font-medium text-zinc-300">
              Hook options
            </label>
            <select
              id="hookCount"
              name="hookCount"
              value={hookCount}
              onChange={(event) => setHookCount(Number(event.target.value))}
              disabled={busy}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
            >
              {HOOK_COUNT_OPTIONS.map((count) => (
                <option key={count} value={count}>
                  {count} hooks
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={busy || tooShort || tooLong}
            className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {busy ? "Generating…" : "Generate"}
          </button>

          {/* Every hook takes a different angle, and there are only six. */}
          <p className="text-xs text-zinc-500">
            Each hook uses a different angle, so {HOOK_COUNT_OPTIONS.at(-1)} is the ceiling.
          </p>
        </div>
      </form>

      {busy ? <LoadingState hookCount={hookCount} /> : null}

      {status === "error" && failure ? <ErrorState failure={failure} /> : null}

      {status === "done" && output ? (
        <Output
          output={output}
          regenerating={regenerating}
          failure={regenerateFailure}
          checkNote={checkNote}
          onRegenerate={onRegenerate}
        />
      ) : null}

      <p className="text-xs text-zinc-600">
        Provider <span className="font-mono">{provider}</span> · model{" "}
        <span className="font-mono">{model}</span>
      </p>
    </div>
  );
}

function LoadingState({ hookCount }: { hookCount: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-sm text-zinc-300"
    >
      Writing {hookCount} hooks, then the script. Two model calls — this takes a
      few seconds.
    </div>
  );
}

function ErrorState({ failure }: { failure: Failure }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-500/50 bg-red-500/5 px-4 py-3 text-sm"
    >
      <p className="font-medium text-red-200">{failure.message}</p>
      {failure.hint ? <p className="mt-1 text-red-300/80">{failure.hint}</p> : null}
    </div>
  );
}

/** The failure line for one half — nothing when the other half is the one that failed. */
function regenerateErrorFor(
  failure: { target: RegenerationTarget; failure: Failure } | null,
  target: RegenerationTarget,
): string | null {
  if (!failure || failure.target !== target) return null;
  return [failure.failure.message, failure.failure.hint].filter(Boolean).join(" ");
}

function Output({
  output,
  regenerating,
  failure,
  checkNote,
  onRegenerate,
}: {
  output: OutputState;
  regenerating: RegenerationTarget | null;
  failure: { target: RegenerationTarget; failure: Failure } | null;
  checkNote: string | null;
  onRegenerate: (target: RegenerationTarget, steer: string) => void;
}) {
  return (
    <div className="flex flex-col gap-8">
      {output.usedExampleProfile ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          No <code className="font-mono">data/voice-profile.json</code> yet, so this
          was written in the example profile&rsquo;s voice rather than yours. Run{" "}
          <code className="font-mono">npm run voice:distill</code> to build your own.
        </p>
      ) : null}

      {output.profileWarnings.map((warning) => (
        <p key={warning} className="text-sm text-zinc-500">
          Voice profile note: {warning}
        </p>
      ))}

      {checkNote ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          The rewrite came back with a failed check — {checkNote}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <HookList hooks={output.hooks} generationId={output.hooksGenerationId} />
        <RegenerateControls
          target="hooks"
          busy={regenerating === "hooks"}
          disabled={regenerating === "script"}
          error={regenerateErrorFor(failure, "hooks")}
          onRegenerate={(steer) => onRegenerate("hooks", steer)}
        />
        <p className="text-xs text-zinc-600">
          A rewrite is told which hooks you have already seen, so round two is a
          different set rather than the same lines reordered. The script below is
          left alone.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <ScriptView
          script={output.script}
          idea={output.idea}
          generationId={output.scriptGenerationId}
        />
        <RegenerateControls
          target="script"
          busy={regenerating === "script"}
          disabled={regenerating === "hooks"}
          error={regenerateErrorFor(failure, "script")}
          onRegenerate={(steer) => onRegenerate("script", steer)}
        />
      </div>

      <p className="text-xs text-zinc-600">
        {output.latest.provider} · {output.latest.model} · {output.latest.latencyMs}ms ·{" "}
        {output.latest.cacheReadTokens} cached input tokens · hooks trace{" "}
        <span className="font-mono">{output.hooksGenerationId}</span> · script trace{" "}
        <span className="font-mono">{output.scriptGenerationId}</span>
      </p>
    </div>
  );
}
