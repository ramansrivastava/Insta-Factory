import { z } from "zod";

import { getAdapter } from "../llm/index.ts";
import type { LlmAdapter, StructuredRequest, StructuredResult } from "../llm/types.ts";
import {
  EmojiUsageSchema,
  VocabularyRegisterSchema,
  VoiceTraitsSchema,
  type VoiceProfile,
  type VoiceTraits,
} from "../../types/voice.ts";
import { normalizeBannedPhrases } from "./banned.ts";

/**
 * Trait distillation: 3-5 pasted captions or scripts in, one structured LLM
 * call out.
 *
 * This runs *once*, offline from the core loop, and its output is written back
 * as an editable profile the creator reviews — it is never applied silently.
 * That is the market pattern (Jasper, Copy.ai) and it is also what makes the
 * generation path cheap: every later call sends the distilled traits, not the
 * raw samples.
 */

export const VOICE_DISTILL_KIND = "voice-distill";

export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 5;

const Phrase = z.string().trim().min(1).max(200);

/**
 * The shape asked of the model.
 *
 * Deliberately not `VoiceTraitsSchema` itself: that schema gives the array
 * fields `.default([])` so a hand-edited profile may omit them, which makes
 * them *optional* in the generated JSON Schema. A model handed an optional
 * field will sometimes just leave it out. Here every field is required, and the
 * result is re-parsed through `VoiceTraitsSchema` afterwards so the two can
 * never drift apart unnoticed.
 */
export const DistilledTraitsSchema = z.object({
  tone: z.string().trim().min(1).max(400),
  sentence_rhythm: z.string().trim().min(1).max(400),
  opener_patterns: z.array(Phrase).max(10),
  recurring_phrases: z.array(Phrase).max(20),
  banned_phrases: z.array(Phrase).max(40),
  emoji_usage: EmojiUsageSchema,
  vocabulary_register: VocabularyRegisterSchema,
});

export class VoiceDistillError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "VoiceDistillError";
    this.cause = cause;
  }
}

const SYSTEM_PROMPT = `You analyse a single creator's short-form Instagram writing and distil it into a reusable voice profile.

Rules:
- Describe what is ACTUALLY on the page. Never invent a trait the samples do not show.
- Describe STRUCTURE, not just word choice: how sentences are paced, how a post opens, where the turn happens. Copying surface vocabulary while missing structure is the most common failure here.
- opener_patterns are shapes ("blunt one-line claim, then a beat"), not verbatim copies of a sample.
- recurring_phrases are the creator's signature words, quoted exactly, only when they appear more than once or are clearly characteristic.
- banned_phrases are generic influencer filler this creator visibly avoids ("game changer", "let's dive in", "in today's video"). Infer them from what is conspicuously absent; keep the list short and specific.
- emoji_usage and vocabulary_register must be judged from the samples, not defaulted.

Output only the structured profile.`;

/** Trims, drops blanks, and enforces the 3-5 sample window. */
export function normalizeSamples(samples: readonly string[]): string[] {
  const cleaned = samples.map((sample) => sample.trim()).filter(Boolean);

  if (cleaned.length < MIN_SAMPLES || cleaned.length > MAX_SAMPLES) {
    throw new VoiceDistillError(
      `Distillation needs between ${MIN_SAMPLES} and ${MAX_SAMPLES} non-empty samples; got ${cleaned.length}.`,
    );
  }

  return cleaned;
}

export function buildDistillRequest(
  samples: readonly string[],
): StructuredRequest<z.infer<typeof DistilledTraitsSchema>> {
  const cleaned = normalizeSamples(samples);
  const body = cleaned
    .map((sample, index) => `<sample index="${index + 1}">\n${sample}\n</sample>`)
    .join("\n\n");

  return {
    kind: VOICE_DISTILL_KIND,
    system: [
      // Identical on every distillation run, so it is a valid cache prefix.
      { text: SYSTEM_PROMPT, cacheable: true },
    ],
    messages: [
      {
        role: "user",
        content: `Here are ${cleaned.length} samples of my writing. Distil my voice profile from them.\n\n${body}`,
      },
    ],
    schema: DistilledTraitsSchema,
    schemaName: "voice_traits",
    maxTokens: 2048,
    // Distillation happens once and everything downstream depends on it, so
    // this is the one call in the product worth spending on.
    effort: "high",
  };
}

export interface DistillOptions {
  adapter?: LlmAdapter;
  env?: Record<string, string | undefined>;
}

export interface DistillResult {
  traits: VoiceTraits;
  provider: StructuredResult<unknown>["provider"];
  model: string;
  usage: StructuredResult<unknown>["usage"];
  latencyMs: number;
}

/**
 * One structured call through the Phase 1 adapter seam. With no
 * `ANTHROPIC_API_KEY` this resolves to the mock adapter and reads
 * `fixtures/llm/voice-distill.json`, so the command works offline.
 */
export async function distillVoiceTraits(
  samples: readonly string[],
  options: DistillOptions = {},
): Promise<DistillResult> {
  const request = buildDistillRequest(samples);
  const adapter = options.adapter ?? getAdapter(options.env);

  const result = await adapter.generateStructured(request);

  const traits = VoiceTraitsSchema.safeParse({
    ...result.data,
    banned_phrases: normalizeBannedPhrases(result.data.banned_phrases),
  });

  if (!traits.success) {
    throw new VoiceDistillError(
      `Distilled traits did not satisfy the voice-profile schema: ${traits.error.message}`,
      traits.error,
    );
  }

  return {
    traits: traits.data,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}

/**
 * Wraps distilled traits into a full profile, carrying over the examples of an
 * existing profile when there is one. The caller writes this to a *draft* file
 * for review — distillation never overwrites the live profile on its own.
 */
export function toDraftProfile(
  traits: VoiceTraits,
  existing?: VoiceProfile,
): VoiceProfile {
  return {
    traits,
    examples: existing?.examples ?? [],
    updated_at: new Date().toISOString(),
  };
}
