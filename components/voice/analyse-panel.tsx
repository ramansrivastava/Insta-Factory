"use client";

import { useState } from "react";

import type { VoiceExample, VoiceExampleType } from "@/types/voice.ts";
import {
  DISTILL_MAX_SAMPLES,
  DISTILL_MIN_SAMPLES,
  MIN_SAMPLE_LENGTH,
} from "@/types/voice-api.ts";

import {
  blankExample,
  parseTags,
  removeAt,
  replaceAt,
  sampleReadiness,
} from "./voice-draft.ts";

/**
 * Onboarding step one: paste 3-5 things you have already written.
 *
 * Pasting is the whole seeding mechanism, deliberately. Pulling captions from
 * Instagram needs a Meta app registration and review, and zero-shot voice
 * matching does not work — every implementation that produces a recognisable
 * voice starts from a seed corpus. So the corpus is asked for plainly rather
 * than approximated from a tone dropdown.
 */

const TYPES: { value: VoiceExampleType; label: string }[] = [
  { value: "caption", label: "Caption" },
  { value: "script", label: "Reel script" },
];

function initialSamples(): VoiceExample[] {
  return Array.from({ length: DISTILL_MIN_SAMPLES }, () => blankExample());
}

export function AnalysePanel({
  busy,
  onAnalyse,
}: {
  busy: boolean;
  onAnalyse: (samples: VoiceExample[]) => void;
}) {
  const [samples, setSamples] = useState<VoiceExample[]>(initialSamples);

  const readiness = sampleReadiness(samples);
  const canAdd = samples.length < DISTILL_MAX_SAMPLES;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !readiness.ready) return;
    onAnalyse(
      samples
        .filter((sample) => sample.text.trim().length >= MIN_SAMPLE_LENGTH)
        .map((sample) => ({ ...sample, text: sample.text.trim() })),
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ol className="flex flex-col gap-4">
        {samples.map((sample, index) => (
          <li
            key={index}
            className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Sample {index + 1}
              </span>

              <select
                value={sample.type}
                aria-label={`Sample ${index + 1} type`}
                disabled={busy}
                onChange={(event) =>
                  setSamples(
                    replaceAt(samples, index, {
                      ...sample,
                      type: event.target.value as VoiceExampleType,
                    }),
                  )
                }
                className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
              >
                {TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>

              {samples.length > DISTILL_MIN_SAMPLES ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSamples(removeAt(samples, index))}
                  className="ml-auto rounded-lg border border-zinc-800 px-3 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
                >
                  Remove
                </button>
              ) : null}
            </div>

            <textarea
              rows={5}
              maxLength={5000}
              value={sample.text}
              disabled={busy}
              aria-label={`Sample ${index + 1} text`}
              placeholder="Paste a caption or script you actually posted. Unedited — the mistakes are part of the voice."
              onChange={(event) =>
                setSamples(replaceAt(samples, index, { ...sample, text: event.target.value }))
              }
              className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
            />

            <input
              type="text"
              value={sample.tags.join(", ")}
              disabled={busy}
              aria-label={`Sample ${index + 1} tags`}
              placeholder="Optional tags: storytime, mythbust, tutorial"
              onChange={(event) =>
                setSamples(
                  replaceAt(samples, index, { ...sample, tags: parseTags(event.target.value) }),
                )
              }
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
            />
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || !readiness.ready}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {busy ? "Analysing…" : "Analyse my voice"}
        </button>

        <button
          type="button"
          disabled={!canAdd || busy}
          onClick={() => setSamples([...samples, blankExample()])}
          className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
        >
          Add another sample
        </button>

        <span className="text-xs text-zinc-500">{readiness.message}</span>
      </div>

      <p className="text-xs text-zinc-600">
        {DISTILL_MIN_SAMPLES}–{DISTILL_MAX_SAMPLES} samples, one model call. Nothing is
        saved until you review the result and press save.
      </p>
    </form>
  );
}
