import { mergeBannedPhrases, SEED_BANNED_PHRASES } from "@/lib/voice/defaults.ts";
import {
  EXAMPLE_WARN_THRESHOLD,
  MAX_EXAMPLES,
  type EmojiUsage,
  type VocabularyRegister,
  type VoiceExample,
  type VoiceExampleType,
  type VoiceProfile,
} from "@/types/voice.ts";
import {
  DISTILL_MAX_SAMPLES,
  DISTILL_MIN_SAMPLES,
  MIN_SAMPLE_LENGTH,
  VoiceProfileUpdateSchema,
  type VoiceProfileUpdate,
} from "@/types/voice-api.ts";

/**
 * The editor's state, and the pure functions over it.
 *
 * Separated from the components so the rules that actually matter — the example
 * cap, the past-six warning, what counts as a saveable profile — can be tested
 * without a browser. They are also the rules the *server* enforces, and a test
 * that pins both against the same schema is what stops the UI drifting into
 * permitting something the API rejects.
 *
 * The draft's text fields are plain strings, including where the profile schema
 * demands non-empty ones. An editor that refuses to let you clear a field
 * before retyping it is a worse editor; validation happens on save.
 */

export interface VoiceDraft {
  tone: string;
  sentence_rhythm: string;
  opener_patterns: string[];
  recurring_phrases: string[];
  banned_phrases: string[];
  emoji_usage: EmojiUsage;
  vocabulary_register: VocabularyRegister;
  examples: VoiceExample[];
}

/** A first-run draft: nothing distilled yet, but the AI tells already banned. */
export function emptyDraft(seedBannedPhrases: readonly string[] = SEED_BANNED_PHRASES): VoiceDraft {
  return {
    tone: "",
    sentence_rhythm: "",
    opener_patterns: [],
    recurring_phrases: [],
    banned_phrases: [...seedBannedPhrases],
    emoji_usage: "occasional",
    vocabulary_register: "conversational",
    examples: [],
  };
}

export function draftFromProfile(profile: VoiceProfile): VoiceDraft {
  return {
    tone: profile.traits.tone,
    sentence_rhythm: profile.traits.sentence_rhythm,
    opener_patterns: [...profile.traits.opener_patterns],
    recurring_phrases: [...profile.traits.recurring_phrases],
    banned_phrases: [...profile.traits.banned_phrases],
    emoji_usage: profile.traits.emoji_usage,
    vocabulary_register: profile.traits.vocabulary_register,
    examples: profile.examples.map((example) => ({ ...example, tags: [...example.tags] })),
  };
}

/**
 * Draft → PUT body. Blank list entries are dropped rather than sent: an empty
 * row is how a half-typed phrase looks, not a phrase the creator meant.
 */
export function draftToUpdate(draft: VoiceDraft): VoiceProfileUpdate {
  const phrases = (values: readonly string[]) =>
    values.map((value) => value.trim()).filter(Boolean);

  return {
    traits: {
      tone: draft.tone.trim(),
      sentence_rhythm: draft.sentence_rhythm.trim(),
      opener_patterns: phrases(draft.opener_patterns),
      recurring_phrases: phrases(draft.recurring_phrases),
      banned_phrases: mergeBannedPhrases(phrases(draft.banned_phrases), []),
      emoji_usage: draft.emoji_usage,
      vocabulary_register: draft.vocabulary_register,
    },
    examples: draft.examples
      .filter((example) => example.text.trim().length > 0)
      .map((example) => ({
        type: example.type,
        text: example.text.trim(),
        tags: example.tags.map((tag) => tag.trim()).filter(Boolean),
      })),
  };
}

/**
 * Client-side validation against the *same* schema the route uses, so the
 * disabled Save button and the server's 400 can never disagree about what is
 * valid. Returns human-readable problems, empty when the draft is saveable.
 */
export function draftProblems(draft: VoiceDraft): string[] {
  const parsed = VoiceProfileUpdateSchema.safeParse(draftToUpdate(draft));
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const where = issue.path.map(String).join(".");
    return where ? `${where}: ${issue.message}` : issue.message;
  });
}

export interface ExampleCapState {
  count: number;
  /** True when adding another is refused — the schema would reject it anyway. */
  atCap: boolean;
  /** Past the warn threshold: allowed, but working against the creator. */
  overWarnThreshold: boolean;
  remaining: number;
  /** Rendered under the example list; null when there is nothing to say. */
  message: string | null;
}

/**
 * The cap and the warning are two different things and the UI has to say so.
 *
 * Ten is a hard stop the schema enforces. Six is where extra examples start
 * *hurting* — the over-prompting finding (arXiv 2509.13196) is that the
 * relationship between example count and output quality is not monotonic. A
 * silently-enforced limit reads as a bug; an explained one reads as a design.
 */
export function exampleCapState(count: number): ExampleCapState {
  const atCap = count >= MAX_EXAMPLES;
  const overWarnThreshold = count > EXAMPLE_WARN_THRESHOLD;

  let message: string | null = null;
  if (atCap) {
    message = `${MAX_EXAMPLES} of ${MAX_EXAMPLES} — this is the hard cap. Remove one to add another.`;
  } else if (overWarnThreshold) {
    message = `${count} examples. Past ${EXAMPLE_WARN_THRESHOLD}, more examples usually make voice matching worse, not better — the model starts averaging across them instead of imitating one voice. Keep the ones that sound most like you and drop the rest.`;
  } else if (count === 0) {
    message =
      "No examples yet. Distilled traits alone give the model nothing concrete to imitate — 3 to 6 of your own captions or scripts is the sweet spot.";
  }

  return {
    count,
    atCap,
    overWarnThreshold,
    remaining: Math.max(0, MAX_EXAMPLES - count),
    message,
  };
}

/** Adding is a no-op at the cap. Enforced here so every caller inherits it. */
export function addExample(
  examples: readonly VoiceExample[],
  example: VoiceExample,
): VoiceExample[] {
  if (examples.length >= MAX_EXAMPLES) return [...examples];
  return [...examples, example];
}

export function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, position) => position !== index);
}

export function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, position) => (position === index ? value : item));
}

export function blankExample(type: VoiceExampleType = "caption"): VoiceExample {
  return { type, text: "", tags: [] };
}

/** Splits a comma-separated tag field into the schema's tag array. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input.split(",")) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    // The schema allows at most 10 tags of 40 characters each.
    if (tags.length < 10) tags.push(tag.slice(0, 40));
  }
  return tags;
}

export interface SampleReadiness {
  usable: number;
  ready: boolean;
  message: string;
}

/** Whether the pasted samples are enough to run "Analyse my voice". */
export function sampleReadiness(samples: readonly { text: string }[]): SampleReadiness {
  const usable = samples.filter(
    (sample) => sample.text.trim().length >= MIN_SAMPLE_LENGTH,
  ).length;

  if (usable < DISTILL_MIN_SAMPLES) {
    return {
      usable,
      ready: false,
      message: `${usable} of ${DISTILL_MIN_SAMPLES} samples ready. Each needs at least ${MIN_SAMPLE_LENGTH} characters.`,
    };
  }

  if (usable > DISTILL_MAX_SAMPLES) {
    return {
      usable,
      ready: false,
      message: `${usable} samples — analyse at most ${DISTILL_MAX_SAMPLES} at a time. Beyond that the read of your voice blurs rather than sharpens.`,
    };
  }

  return {
    usable,
    ready: true,
    message: `${usable} samples ready to analyse.`,
  };
}
