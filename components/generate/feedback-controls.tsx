"use client";

import { useState } from "react";

import {
  FEEDBACK_OUTCOMES,
  FEEDBACK_OUTCOME_LABELS,
  MAX_EDITED_TEXT_LENGTH,
  type FeedbackOutcome,
} from "@/types/feedback.ts";

import {
  buildFeedbackPayload,
  confirmationFor,
  isEditEmpty,
  isEditTooLong,
  type FeedbackSubject,
} from "./feedback.ts";

/**
 * Used as-is / Edited / Discarded, on every hook and on the script.
 *
 * This is the product's only source of ground truth about whether the writing
 * was any good. Audience response is not observable at generation time and an
 * LLM judge is weakest at exactly the subjective creative call this needs, so
 * what the creator *did with the words* is the signal — and it is only ever
 * collected if pressing the button is cheaper than not pressing it.
 *
 * Hence: three buttons, one optional box, no modal, no star rating, no "tell us
 * more". "Edited" reveals a textarea because the rewrite is the most valuable
 * record here (it is a labelled pair: what we wrote, what she says instead),
 * and it cannot be saved empty: an "edited" record with no rewrite is a hole
 * in the only ground truth this collects, and nothing later can fill it in.
 * "Discarded" is the button for a hook that was rewritten out of existence.
 */

type Status = "idle" | "saving" | "saved" | "failed";

export function FeedbackControls({
  subject,
  label,
}: {
  subject: FeedbackSubject;
  /** Names what is being rated, for screen readers. */
  label: string;
}) {
  const [chosen, setChosen] = useState<FeedbackOutcome | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editedText, setEditedText] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const tooLong = isEditTooLong(editedText);
  const empty = isEditEmpty(editedText);
  const busy = status === "saving";

  async function send(outcome: FeedbackOutcome, text: string) {
    setStatus("saving");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildFeedbackPayload(subject, outcome, text)),
      });
      if (!response.ok) {
        setStatus("failed");
        return;
      }
      setChosen(outcome);
      setStatus("saved");
      if (outcome !== "edited") setShowEditor(false);
    } catch {
      setStatus("failed");
    }
  }

  function onChoose(outcome: FeedbackOutcome) {
    if (busy) return;
    if (outcome === "edited") {
      // The rewrite is the payload, so opening the box is the whole action —
      // nothing is sent until there is something to send it with.
      setShowEditor(true);
      setChosen("edited");
      setStatus("idle");
      return;
    }
    void send(outcome, "");
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label={`What did you do with ${label}?`}
        className="flex flex-wrap items-center gap-2"
      >
        {FEEDBACK_OUTCOMES.map((outcome) => (
          <button
            key={outcome}
            type="button"
            onClick={() => onChoose(outcome)}
            disabled={busy}
            aria-pressed={chosen === outcome}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              chosen === outcome
                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100"
            }`}
          >
            {FEEDBACK_OUTCOME_LABELS[outcome]}
          </button>
        ))}

        {status === "saved" && chosen ? (
          <span aria-live="polite" className="text-xs text-emerald-300">
            {confirmationFor(chosen)}
          </span>
        ) : null}

        {status === "failed" ? (
          <span aria-live="polite" className="text-xs text-red-300">
            Could not record that. Try again.
          </span>
        ) : null}
      </div>

      {showEditor ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={editorId(subject)} className="text-xs text-zinc-500">
            Paste your version — optional, and the most useful thing you can give
            this tool.
          </label>
          <textarea
            id={editorId(subject)}
            rows={3}
            value={editedText}
            onChange={(event) => setEditedText(event.target.value)}
            disabled={busy}
            placeholder="What you actually said instead."
            className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void send("edited", editedText)}
              disabled={busy || tooLong || empty}
              className="rounded-md border border-zinc-600 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save edit"}
            </button>
            {tooLong ? (
              <span className="text-xs text-red-300">
                {editedText.trim().length} characters — trim it to{" "}
                {MAX_EDITED_TEXT_LENGTH} or fewer.
              </span>
            ) : (
              <span className="text-xs text-zinc-600">
                {empty
                  ? "Paste your version to save it — or press Discarded if you kept none of it."
                  : "Your version is what makes the next one better."}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Unique per rated thing, so several of these can coexist on one page. */
function editorId(subject: FeedbackSubject): string {
  return subject.target === "hook"
    ? `feedback-edit-hook-${subject.hookIndex}`
    : "feedback-edit-script";
}
