"use client";

import Link from "next/link";
import { useState } from "react";

import type { VoiceExample } from "@/types/voice.ts";
import type {
  VoiceErrorBody,
  VoiceProfileBody,
  VoiceProfileSource,
} from "@/types/voice-api.ts";

import { AnalysePanel } from "./analyse-panel.tsx";
import { ExampleList } from "./example-list.tsx";
import { TraitFields } from "./trait-fields.tsx";
import {
  draftFromProfile,
  draftProblems,
  draftToUpdate,
  emptyDraft,
  type VoiceDraft,
} from "./voice-draft.ts";

/**
 * The voice profile screen.
 *
 * The framing is the feature. A distilled profile is shown back as "here is
 * what we think your voice is — correct it", never as a finished analysis,
 * because the model's read is a hypothesis and the creator is the only one who
 * can confirm it. Nothing reaches disk until they press save.
 */

type Status = "idle" | "analysing" | "saving";

interface Failure {
  message: string;
  details: string[];
}

function failureFrom(status: number, body: unknown): Failure {
  const error = (body as VoiceErrorBody | null)?.ok === false
    ? (body as VoiceErrorBody).error
    : null;

  if (error) return { message: error.message, details: error.details ?? [] };
  return {
    message: `The server answered with HTTP ${status} and no explanation.`,
    details: ["That is a bug on our side — the server log will have the cause."],
  };
}

export function VoiceEditor({
  initial,
  onboarding,
}: {
  initial: VoiceProfileBody;
  /** True when a profile-less first load routed the creator here. */
  onboarding: boolean;
}) {
  const [draft, setDraft] = useState<VoiceDraft>(() =>
    initial.profile ? draftFromProfile(initial.profile) : emptyDraft(initial.seedBannedPhrases),
  );
  const [source, setSource] = useState<VoiceProfileSource>(initial.source);
  const [warnings, setWarnings] = useState<string[]>(initial.warnings);
  const [status, setStatus] = useState<Status>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const busy = status !== "idle";
  const problems = draftProblems(draft);
  const distilled = source === "draft";

  async function analyse(samples: VoiceExample[]) {
    setStatus("analysing");
    setFailure(null);

    try {
      const response = await fetch("/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ samples }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok || (body as VoiceProfileBody | null)?.ok !== true) {
        setFailure(failureFrom(response.status, body));
        return;
      }

      const result = body as VoiceProfileBody;
      if (result.profile) {
        setDraft(draftFromProfile(result.profile));
        setSource("draft");
        setWarnings(result.warnings);
        setSavedAt(null);
      }
    } catch {
      setFailure({
        message: "Could not reach the server.",
        details: ["Check that the dev server is still running, then try again."],
      });
    } finally {
      setStatus("idle");
    }
  }

  async function save() {
    if (problems.length > 0) return;
    setStatus("saving");
    setFailure(null);

    try {
      const response = await fetch("/api/voice", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draftToUpdate(draft)),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok || (body as VoiceProfileBody | null)?.ok !== true) {
        setFailure(failureFrom(response.status, body));
        return;
      }

      const result = body as VoiceProfileBody;
      if (result.profile) setDraft(draftFromProfile(result.profile));
      setSource("saved");
      setWarnings(result.warnings);
      setSavedAt(result.profile?.updated_at ?? new Date().toISOString());
    } catch {
      setFailure({
        message: "Could not reach the server.",
        details: ["Nothing was saved. Check the dev server, then press save again."],
      });
    } finally {
      setStatus("idle");
    }
  }

  return (
    <div className="flex flex-col gap-10">
      {onboarding && source !== "saved" ? <OnboardingNote /> : null}

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-medium text-zinc-200">
            {source === "none" ? "Start with what you have written" : "Re-analyse from new samples"}
          </h2>
          <p className="text-sm text-zinc-500">
            {source === "none"
              ? "Paste 3 to 5 captions or scripts you have already posted. One model call reads them and proposes a voice profile you then correct."
              : "Pasting new samples replaces the traits below with a fresh read. Your saved profile is untouched until you press save."}
          </p>
        </div>
        <AnalysePanel busy={status === "analysing"} onAnalyse={analyse} />
      </section>

      {distilled ? <DistilledNote /> : null}

      {failure ? <ErrorState failure={failure} /> : null}

      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-medium text-zinc-200">Your voice, as fields</h2>
          <p className="text-sm text-zinc-500">
            Every one of these is editable. Generation reads them on every call, so a
            correction here changes every script from now on.
          </p>
        </div>

        <TraitFields
          draft={draft}
          onChange={setDraft}
          seedBannedPhrases={initial.seedBannedPhrases}
        />
      </section>

      <ExampleList
        examples={draft.examples}
        onChange={(examples) => setDraft({ ...draft, examples })}
      />

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {warnings.map((warning) => (
            <li key={warning} className="text-sm text-zinc-500">
              Note: {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {problems.length > 0 ? (
        <ul
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200"
        >
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={save}
          disabled={busy || problems.length > 0}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {status === "saving" ? "Saving…" : "Save my voice profile"}
        </button>

        {savedAt ? (
          <p role="status" className="text-sm text-emerald-300">
            Saved to <code className="font-mono">data/voice-profile.json</code>.{" "}
            <Link href="/" className="underline underline-offset-4 hover:text-emerald-200">
              Write something in it →
            </Link>
          </p>
        ) : (
          <p className="text-xs text-zinc-600">
            Saving overwrites <code className="font-mono">data/voice-profile.json</code>.
          </p>
        )}
      </div>
    </div>
  );
}

function OnboardingNote() {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300">
      <p className="font-medium text-zinc-100">You have no voice profile yet.</p>
      <p className="mt-1 text-zinc-400">
        The generator would fall back to a stranger&rsquo;s voice, which is worse than
        useless — so this comes first. It takes one paste and about a minute.{" "}
        <Link
          href="/?skipVoiceSetup=1"
          className="underline underline-offset-4 hover:text-zinc-200"
        >
          Skip and use the example voice
        </Link>
        .
      </p>
    </div>
  );
}

function DistilledNote() {
  return (
    <div
      role="status"
      className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200"
    >
      <p className="font-medium">Here is what we think your voice is — correct it.</p>
      <p className="mt-1 text-emerald-300/80">
        This is the model&rsquo;s read of your samples, not a verdict. It is wrong about
        something; the fields below are where you fix it. Nothing is saved yet.
      </p>
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
      {failure.details.map((detail) => (
        <p key={detail} className="mt-1 text-red-300/80">
          {detail}
        </p>
      ))}
    </div>
  );
}
