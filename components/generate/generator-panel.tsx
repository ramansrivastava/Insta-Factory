"use client";

import { useState } from "react";

import { MAX_IDEA_LENGTH, MIN_IDEA_LENGTH } from "@/lib/generate/idea.ts";
import {
  HOOK_COUNT_OPTIONS,
  type GenerateErrorBody,
  type GenerateSuccessBody,
} from "@/types/api.ts";
import { DEFAULT_HOOK_COUNT } from "@/types/generation.ts";

import { HookList } from "./hook-list.tsx";
import { ScriptView } from "./script-view.tsx";

/**
 * The idea → output screen.
 *
 * Loading and failure are rendered states, not thrown exceptions: this is the
 * one screen of the product, a generation takes seconds and can fail four
 * distinct ways, and an error boundary that blanks the page would also throw
 * away the idea the creator just typed.
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
  const [result, setResult] = useState<GenerateSuccessBody | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

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

      setResult(body as GenerateSuccessBody);
      setStatus("done");
    } catch {
      setFailure({
        message: "Could not reach the generator.",
        hint: "Check that the dev server is still running, then try again.",
      });
      setStatus("error");
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

      {status === "done" && result ? <Output result={result} /> : null}

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

function Output({ result }: { result: GenerateSuccessBody }) {
  return (
    <div className="flex flex-col gap-8">
      {result.meta.usedExampleProfile ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          No <code className="font-mono">data/voice-profile.json</code> yet, so this
          was written in the example profile&rsquo;s voice rather than yours. Run{" "}
          <code className="font-mono">npm run voice:distill</code> to build your own.
        </p>
      ) : null}

      {result.meta.profileWarnings.map((warning) => (
        <p key={warning} className="text-sm text-zinc-500">
          Voice profile note: {warning}
        </p>
      ))}

      <HookList hooks={result.hooks} generationId={result.meta.generationId} />
      <ScriptView
        script={result.script}
        idea={result.idea}
        generationId={result.meta.generationId}
      />

      <p className="text-xs text-zinc-600">
        {result.meta.provider} · {result.meta.model} · {result.meta.latencyMs}ms ·{" "}
        {result.meta.cacheReadTokens} cached input tokens · trace{" "}
        <span className="font-mono">{result.meta.generationId}</span>
      </p>
    </div>
  );
}
