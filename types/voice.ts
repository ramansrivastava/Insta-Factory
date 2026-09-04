import { z } from "zod";

/**
 * The voice profile: distilled, human-editable traits plus a *small* tagged
 * example set.
 *
 * The two numbers below are the load-bearing part of this file. Research on
 * few-shot prompting (arXiv 2509.13196, "The Few-shot Dilemma: Over-prompting
 * LLMs") found that piling on examples can *degrade* output, and arXiv
 * 2509.14543 found frontier models imitate surface word choice while missing
 * structural voice. The design answer is explicit distilled traits plus a few
 * curated examples — not a raw dump of forty captions. `MAX_EXAMPLES` encodes
 * that in the schema so it cannot be quietly regressed, and
 * `EXAMPLE_WARN_THRESHOLD` warns well before the wall is hit.
 */
export const MAX_EXAMPLES = 10;
export const EXAMPLE_WARN_THRESHOLD = 6;

export const VoiceExampleTypeSchema = z.enum(["caption", "script"]);
export type VoiceExampleType = z.infer<typeof VoiceExampleTypeSchema>;

/**
 * Categorical dials. Enums rather than free text so the distillation call and
 * Phase 3's prompt builder agree on a closed vocabulary.
 */
export const EmojiUsageSchema = z.enum(["none", "rare", "occasional", "frequent"]);
export type EmojiUsage = z.infer<typeof EmojiUsageSchema>;

export const VocabularyRegisterSchema = z.enum([
  "casual",
  "conversational",
  "professional",
  "technical",
]);
export type VocabularyRegister = z.infer<typeof VocabularyRegisterSchema>;

const Phrase = z.string().trim().min(1).max(200);

export const VoiceExampleSchema = z.object({
  type: VoiceExampleTypeSchema,
  text: z.string().trim().min(1).max(5000),
  /**
   * Free-form labels ("hook", "story", "educational") so generation can pick
   * the most relevant handful of examples instead of sending all of them.
   */
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});
export type VoiceExample = z.infer<typeof VoiceExampleSchema>;

/**
 * The distilled traits: what `lib/voice/distill.ts` produces and what Phase 3's
 * prompt builder consumes. The raw samples are deliberately not re-sent on
 * every generation call — that is the whole point of distilling.
 */
export const VoiceTraitsSchema = z.object({
  /** How the writing feels, described concretely. */
  tone: z.string().trim().min(1).max(400),
  /** Sentence length and cadence: fragments, long flowing lines, one-liners. */
  sentence_rhythm: z.string().trim().min(1).max(400),
  /** How posts typically open — the structural shape, not verbatim text. */
  opener_patterns: z.array(Phrase).max(10).default([]),
  /** Signature words and phrases worth preserving. */
  recurring_phrases: z.array(Phrase).max(20).default([]),
  /**
   * Phrases the creator never says. Consumed by Phase 3's prompt and by the
   * eval's banned-phrase dimension, which is why it is defined here rather
   * than alongside the generator.
   */
  banned_phrases: z.array(Phrase).max(40).default([]),
  emoji_usage: EmojiUsageSchema,
  vocabulary_register: VocabularyRegisterSchema,
});
export type VoiceTraits = z.infer<typeof VoiceTraitsSchema>;

export const VoiceProfileSchema = z.object({
  traits: VoiceTraitsSchema,
  examples: z
    .array(VoiceExampleSchema)
    .max(MAX_EXAMPLES, {
      message: `A voice profile holds at most ${MAX_EXAMPLES} examples — beyond that, extra examples degrade voice fidelity rather than improving it.`,
    })
    .default([]),
  updated_at: z.iso.datetime(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/** Input shape, before defaults are applied — what a caller may hand to `save`. */
export type VoiceProfileInput = z.input<typeof VoiceProfileSchema>;

/**
 * Advisory checks that are not fatal.
 *
 * Zod can only accept or reject, but "you have 8 examples, which is more than
 * this design wants" is a warning rather than an error — so it lives here and
 * is surfaced by the store and the CLI instead of failing validation.
 */
export function collectVoiceProfileWarnings(profile: VoiceProfile): string[] {
  const warnings: string[] = [];

  if (profile.examples.length > EXAMPLE_WARN_THRESHOLD) {
    warnings.push(
      `${profile.examples.length} examples: past ${EXAMPLE_WARN_THRESHOLD}, extra examples tend to dilute voice rather than sharpen it (hard cap is ${MAX_EXAMPLES}).`,
    );
  }

  if (profile.examples.length === 0) {
    warnings.push(
      "No examples: distilled traits alone give the model nothing concrete to imitate. Add 3-6 captions or scripts.",
    );
  }

  if (profile.traits.banned_phrases.length === 0) {
    warnings.push(
      "No banned_phrases: generation has no explicit list of phrases to avoid, and the eval's banned-phrase check has nothing to measure.",
    );
  }

  return warnings;
}
