"use client";

import { mergeBannedPhrases } from "@/lib/voice/defaults.ts";
import type { EmojiUsage, VocabularyRegister } from "@/types/voice.ts";

import { PhraseList } from "./phrase-list.tsx";
import type { VoiceDraft } from "./voice-draft.ts";

/**
 * The distilled traits, rendered as fields the creator edits rather than a
 * summary they read.
 *
 * This is the differentiating half of the product: the model's read of a voice
 * is a first draft, and the creator is the only authority on whether it is
 * right. Every field here is writable for that reason — including the ones the
 * model felt most confident about.
 */

const EMOJI_USAGE: { value: EmojiUsage; label: string }[] = [
  { value: "none", label: "None — I never use emoji" },
  { value: "rare", label: "Rare — one every few posts" },
  { value: "occasional", label: "Occasional — one or two per post" },
  { value: "frequent", label: "Frequent — they carry the tone" },
];

const REGISTERS: { value: VocabularyRegister; label: string }[] = [
  { value: "casual", label: "Casual — how I talk to a friend" },
  { value: "conversational", label: "Conversational — plain, warm, unfussy" },
  { value: "professional", label: "Professional — precise, still human" },
  { value: "technical", label: "Technical — I use the real terms" },
];

export function TraitFields({
  draft,
  onChange,
  seedBannedPhrases,
}: {
  draft: VoiceDraft;
  onChange: (next: VoiceDraft) => void;
  seedBannedPhrases: string[];
}) {
  const patch = (fields: Partial<VoiceDraft>) => onChange({ ...draft, ...fields });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="tone" className="text-sm font-medium text-zinc-300">
          Tone
        </label>
        <textarea
          id="tone"
          rows={3}
          maxLength={400}
          value={draft.tone}
          onChange={(event) => patch({ tone: event.target.value })}
          placeholder="Blunt and warm at the same time. Talks to one person, not an audience."
          className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <p className="text-xs text-zinc-500">
          How the writing feels. Concrete beats flattering — &ldquo;impatient with
          preamble&rdquo; is more useful than &ldquo;engaging&rdquo;.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="sentence_rhythm" className="text-sm font-medium text-zinc-300">
          Sentence rhythm
        </label>
        <textarea
          id="sentence_rhythm"
          rows={3}
          maxLength={400}
          value={draft.sentence_rhythm}
          onChange={(event) => patch({ sentence_rhythm: event.target.value })}
          placeholder="Short declaratives, often fragments. One-line opener, longer middle, one-line close."
          className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <p className="text-xs text-zinc-500">
          Pacing and sentence length. This is the trait models most often miss —
          they copy your words and lose your cadence.
        </p>
      </div>

      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="emoji_usage" className="text-sm font-medium text-zinc-300">
            Emoji usage
          </label>
          <select
            id="emoji_usage"
            value={draft.emoji_usage}
            onChange={(event) => patch({ emoji_usage: event.target.value as EmojiUsage })}
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
          >
            {EMOJI_USAGE.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="vocabulary_register" className="text-sm font-medium text-zinc-300">
            Vocabulary register
          </label>
          <select
            id="vocabulary_register"
            value={draft.vocabulary_register}
            onChange={(event) =>
              patch({ vocabulary_register: event.target.value as VocabularyRegister })
            }
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
          >
            {REGISTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <PhraseList
        id="opener"
        label="Opener patterns"
        hint="The shapes your posts open with, not verbatim lines. “Flat contradiction of a common belief, then a beat.”"
        placeholder="A number or timeframe stated bare, no setup"
        values={draft.opener_patterns}
        maxItems={10}
        onChange={(opener_patterns) => patch({ opener_patterns })}
      />

      <PhraseList
        id="recurring"
        label="Recurring phrases"
        hint="Words and phrases that are yours. These get preserved verbatim in generated copy."
        placeholder="here's the boring part"
        values={draft.recurring_phrases}
        maxItems={20}
        onChange={(recurring_phrases) => patch({ recurring_phrases })}
      />

      <PhraseList
        id="banned"
        label="Banned phrases"
        hint="Phrases you never say. Generation is checked against this list before you ever see the output, so anything here is a hard fail rather than a suggestion."
        placeholder="unlock the power of"
        values={draft.banned_phrases}
        maxItems={40}
        onChange={(banned_phrases) => patch({ banned_phrases })}
        action={{
          label: "Add the common AI tells",
          title: "Adds the phrases that give away model-written copy. Duplicates are skipped.",
          onClick: () =>
            patch({
              banned_phrases: mergeBannedPhrases(draft.banned_phrases, seedBannedPhrases),
            }),
        }}
      />
    </section>
  );
}
