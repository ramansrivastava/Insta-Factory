"use client";

import { removeAt, replaceAt } from "./voice-draft.ts";

/**
 * One editable list of short phrases — opener patterns, recurring phrases,
 * banned phrases.
 *
 * A textarea of newline-separated lines would have been less code, but these
 * are schema-bounded arrays with a per-item length limit, and a blob of text
 * hides which line is the one the server rejected. One input per phrase keeps
 * the error attributable to the field that caused it.
 */

export function PhraseList({
  id,
  label,
  hint,
  placeholder,
  values,
  maxItems,
  onChange,
  action,
}: {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  values: string[];
  maxItems: number;
  onChange: (next: string[]) => void;
  /** Optional extra control rendered beside "Add" (used to seed AI tells). */
  action?: { label: string; onClick: () => void; title?: string };
}) {
  const atCap = values.length >= maxItems;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-zinc-300">{label}</legend>
      <p className="text-xs text-zinc-500">{hint}</p>

      <ul className="flex flex-col gap-2">
        {values.map((value, index) => (
          <li key={`${id}-${index}`} className="flex items-center gap-2">
            <input
              type="text"
              value={value}
              aria-label={`${label} ${index + 1}`}
              placeholder={placeholder}
              maxLength={200}
              onChange={(event) => onChange(replaceAt(values, index, event.target.value))}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => onChange(removeAt(values, index))}
              aria-label={`Remove ${label} ${index + 1}`}
              className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={atCap}
          onClick={() => onChange([...values, ""])}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
        >
          Add
        </button>

        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            title={action.title}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
          >
            {action.label}
          </button>
        ) : null}

        <span className="text-xs text-zinc-600">
          {values.length}/{maxItems}
          {atCap ? " — that is the schema limit for this list." : ""}
        </span>
      </div>
    </fieldset>
  );
}
