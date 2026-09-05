"use client";

import { MAX_EXAMPLES, type VoiceExample, type VoiceExampleType } from "@/types/voice.ts";

import {
  addExample,
  blankExample,
  exampleCapState,
  parseTags,
  removeAt,
  replaceAt,
} from "./voice-draft.ts";

/**
 * The example set: add, remove, retype, retag.
 *
 * Two limits are visible here and they mean different things. Ten is a hard cap
 * the schema enforces — the Add button switches off. Six is a *warning*: past
 * it, extra examples measurably degrade voice matching rather than improving
 * it, and the creator is told why rather than left to discover a ceiling that
 * looks arbitrary.
 */

const TYPES: { value: VoiceExampleType; label: string }[] = [
  { value: "caption", label: "Caption" },
  { value: "script", label: "Reel script" },
];

export function ExampleList({
  examples,
  onChange,
}: {
  examples: VoiceExample[];
  onChange: (next: VoiceExample[]) => void;
}) {
  const cap = exampleCapState(examples.length);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium text-zinc-200">Your examples</h2>
        <p className="text-sm text-zinc-500">
          The writing the generator imitates directly. Traits describe your voice;
          these show it.
        </p>
      </div>

      <ul className="flex flex-col gap-4">
        {examples.map((example, index) => (
          <li
            key={index}
            className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor={`example-type-${index}`}
                className="text-xs font-medium uppercase tracking-wide text-zinc-500"
              >
                Type
              </label>
              <select
                id={`example-type-${index}`}
                value={example.type}
                onChange={(event) =>
                  onChange(
                    replaceAt(examples, index, {
                      ...example,
                      type: event.target.value as VoiceExampleType,
                    }),
                  )
                }
                className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
              >
                {TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => onChange(removeAt(examples, index))}
                className="ml-auto rounded-lg border border-zinc-800 px-3 py-1 text-xs text-zinc-400 transition-colors hover:border-red-500/60 hover:text-red-200"
              >
                Remove example {index + 1}
              </button>
            </div>

            <textarea
              rows={4}
              maxLength={5000}
              value={example.text}
              aria-label={`Example ${index + 1} text`}
              placeholder="Paste one of your captions or scripts, exactly as you posted it."
              onChange={(event) =>
                onChange(replaceAt(examples, index, { ...example, text: event.target.value }))
              }
              className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
            />

            <div className="flex flex-col gap-1">
              <label
                htmlFor={`example-tags-${index}`}
                className="text-xs font-medium uppercase tracking-wide text-zinc-500"
              >
                Tags
              </label>
              <input
                id={`example-tags-${index}`}
                type="text"
                value={example.tags.join(", ")}
                placeholder="storytime, mythbust, personal"
                onChange={(event) =>
                  onChange(
                    replaceAt(examples, index, {
                      ...example,
                      tags: parseTags(event.target.value),
                    }),
                  )
                }
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
              <p className="text-xs text-zinc-600">
                Comma-separated. Tags let generation pick the examples closest to
                what you are writing instead of sending all of them.
              </p>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={cap.atCap}
          onClick={() => onChange(addExample(examples, blankExample()))}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
        >
          Add an example
        </button>
        <span className="text-xs text-zinc-500">
          {cap.count}/{MAX_EXAMPLES}
        </span>
      </div>

      {cap.message ? (
        <p
          role={cap.overWarnThreshold || cap.atCap ? "alert" : undefined}
          className={
            cap.overWarnThreshold || cap.atCap
              ? "rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200"
              : "text-sm text-zinc-500"
          }
        >
          {cap.message}
        </p>
      ) : null}
    </section>
  );
}
