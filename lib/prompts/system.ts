import type { SystemBlock } from "../llm/types.ts";
import type { VoiceExample, VoiceProfile, VoiceTraits } from "../../types/voice.ts";

/**
 * The cacheable prefix: role framing, the rendered traits block, then the
 * tagged examples.
 *
 * Two rules govern everything in this file.
 *
 * 1. **Nothing per-request may appear here.** The idea, a timestamp, a
 *    generation id, an unsorted object — any of them invalidates the prompt
 *    cache silently, with no error and no exception, and the only symptom is a
 *    `cache_read_input_tokens` of zero. The idea goes in the user turn, after
 *    the last cache breakpoint. `updated_at` is deliberately *not* rendered:
 *    it changes every time the creator edits their profile, which is fine, but
 *    it carries no information the model can use.
 * 2. **Traits are sent, raw samples are not.** Distillation (Phase 2) exists so
 *    that every generation call carries a compact profile rather than the whole
 *    caption corpus. The example set is capped at 10 by the schema because more
 *    few-shot examples measurably degrade voice matching past a point
 *    (arXiv 2509.13196) — this renderer must never work around that cap.
 */

const ROLE_FRAMING = `You are ghostwriting short-form Instagram video content for one specific creator.

You are not a brand voice engine and you are not writing "in a tone". You are writing as this person: their rhythm, their vocabulary, the shapes their sentences actually take. A reader who knows their feed should not be able to tell this was drafted for them.

Two rules override everything else:

1. VOICE. Match the profile below exactly. Where the profile and generic "good copywriting" disagree, the profile wins. Do not smooth their edges, do not add polish they do not have, do not reach for the phrasings every creator uses.
2. GROUNDING. You elaborate only on what the creator supplied. You may add structure, framing, pacing and transitions. You may NOT add a fact, a statistic, a percentage, a study, a named person, a brand, a place, or any number that is not already in their idea. If a line would be stronger with a number you do not have, write the line without the number. Inventing plausible detail is the single worst thing you can do here — it puts words in their mouth that they cannot stand behind.`;

/** Renders the distilled traits. Deterministic: same profile in, same bytes out. */
export function renderTraits(traits: VoiceTraits): string {
  const lines: string[] = [
    "<voice_profile>",
    `tone: ${traits.tone}`,
    `sentence_rhythm: ${traits.sentence_rhythm}`,
    `vocabulary_register: ${traits.vocabulary_register}`,
    `emoji_usage: ${traits.emoji_usage}`,
  ];

  lines.push(...renderList("opens_posts_like", traits.opener_patterns));
  lines.push(
    ...renderList(
      "signature_phrases (use where they fit naturally; do not force all of them)",
      traits.recurring_phrases,
    ),
  );
  lines.push(
    ...renderList(
      "never_write_these (this creator does not talk like this)",
      traits.banned_phrases,
    ),
  );

  lines.push("</voice_profile>");
  return lines.join("\n");
}

function renderList(label: string, items: readonly string[]): string[] {
  if (items.length === 0) return [`${label}: (none recorded)`];
  return [`${label}:`, ...items.map((item) => `  - ${item}`)];
}

/** Renders the tagged example set, in profile order. */
export function renderExamples(examples: readonly VoiceExample[]): string {
  if (examples.length === 0) {
    return "<voice_examples>\n(none supplied — rely on the profile above)\n</voice_examples>";
  }

  const blocks = examples.map((example, index) => {
    const tags = example.tags.length > 0 ? ` tags="${example.tags.join(", ")}"` : "";
    return `<example index="${index + 1}" type="${example.type}"${tags}>\n${example.text}\n</example>`;
  });

  return [
    "<voice_examples>",
    "Real writing by this creator. Imitate how these are BUILT — where the turn happens, how long a thought runs, what gets left out — not just which words appear in them.",
    ...blocks,
    "</voice_examples>",
  ].join("\n");
}

/**
 * The three blocks shared by both calls in the pipeline, all flagged cacheable.
 *
 * Both the hooks call and the script call open with exactly these bytes, so the
 * second call of a generation reads the first call's cache.
 */
export function buildVoiceSystemBlocks(profile: VoiceProfile): SystemBlock[] {
  return [
    { text: ROLE_FRAMING, cacheable: true },
    { text: renderTraits(profile.traits), cacheable: true },
    { text: renderExamples(profile.examples), cacheable: true },
  ];
}

/**
 * A one-line restatement of the voice, cheap enough to repeat.
 *
 * The script prompt re-injects this before *every* section instruction rather
 * than stating the voice once at the top. Instruction drift — the model
 * honouring an instruction at the start of a long generation and quietly
 * abandoning it by the end — is the most-cited cause of AI writing reverting to
 * generic, and it gets worse the longer the output. A Reel script is the long
 * half of this product, so it is where the repetition is spent.
 */
export function renderVoiceReminder(traits: VoiceTraits): string {
  const parts = [
    firstSentence(traits.tone),
    firstSentence(traits.sentence_rhythm),
    `${traits.vocabulary_register} register`,
    `${traits.emoji_usage} emoji`,
  ].filter(Boolean);

  return `[their voice: ${parts.join(" · ")}]`;
}

/** First sentence, trimmed — the reminder has to stay short to be worth repeating. */
function firstSentence(text: string): string {
  const match = /^[^.!?]*[.!?]?/.exec(text.trim());
  const sentence = (match?.[0] ?? text).trim().replace(/[.!?]+$/, "");
  return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}...` : sentence;
}

/**
 * The banned-phrase instruction, shared by both prompts.
 *
 * Rendered separately from the traits block so each task prompt can restate it
 * close to where the writing happens, for the same drift reason as above.
 */
export function renderBannedReminder(traits: VoiceTraits): string {
  if (traits.banned_phrases.length === 0) return "";
  return `Do not use any of these, in any casing or punctuation: ${traits.banned_phrases
    .map((phrase) => `"${phrase}"`)
    .join(", ")}.`;
}
