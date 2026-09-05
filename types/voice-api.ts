import { z } from "zod";

import type { GenerateErrorBody } from "./api.ts";
import {
  VoiceExampleSchema,
  VoiceProfileSchema,
  VoiceTraitsSchema,
  type VoiceProfile,
} from "./voice.ts";

/**
 * The wire contract for `/api/voice`, shared by the route handler and the
 * browser.
 *
 * Same rule as `types/api.ts`: this module must not reach into `lib/llm/` or
 * anything touching `node:fs`, because the voice editor is a client component
 * and importing it would drag the Anthropic SDK into the browser bundle. The
 * distillation sample bounds are therefore restated here as literals rather
 * than imported from `lib/voice/distill.ts` — `tests/voice-route.test.ts`
 * asserts the two agree, so they cannot drift apart silently.
 */

export const DISTILL_MIN_SAMPLES = 3;
export const DISTILL_MAX_SAMPLES = 5;

/**
 * A sample shorter than this is not a writing sample. The distiller would
 * happily accept "yes" and return traits invented from nothing, which is the
 * exact failure the system prompt is written to avoid.
 */
export const MIN_SAMPLE_LENGTH = 20;

/**
 * PUT body: the profile without `updated_at`.
 *
 * The timestamp is the server's to write — a client that sends its own would
 * either be ignored or, worse, believed. `examples` reuses the profile
 * schema's own field so the `MAX_EXAMPLES` cap is enforced here by the same
 * definition that enforces it on disk, not by a second copy of the number.
 */
export const VoiceProfileUpdateSchema = z.strictObject({
  traits: VoiceTraitsSchema,
  examples: VoiceProfileSchema.shape.examples,
});

export type VoiceProfileUpdate = z.infer<typeof VoiceProfileUpdateSchema>;

/** POST body: the pasted samples, each already tagged by type. */
export const VoiceDistillRequestSchema = z.strictObject({
  samples: z
    .array(
      VoiceExampleSchema.extend({
        text: z
          .string()
          .trim()
          .min(
            MIN_SAMPLE_LENGTH,
            `Each sample needs at least ${MIN_SAMPLE_LENGTH} characters — paste a real caption or script, not a fragment.`,
          )
          .max(5000),
      }),
    )
    .min(
      DISTILL_MIN_SAMPLES,
      `Paste at least ${DISTILL_MIN_SAMPLES} samples — fewer than that and the distilled traits are guesswork.`,
    )
    .max(
      DISTILL_MAX_SAMPLES,
      `At most ${DISTILL_MAX_SAMPLES} samples. More does not sharpen the read of your voice; it dilutes it.`,
    ),
});

export type VoiceDistillRequest = z.infer<typeof VoiceDistillRequestSchema>;

/** Where the profile in a response came from. */
export type VoiceProfileSource =
  /** The creator's own `data/voice-profile.json`. */
  | "saved"
  /** Nothing saved yet — the response carries no profile. */
  | "none"
  /** Freshly distilled, not yet written anywhere. */
  | "draft";

export interface VoiceProfileBody {
  ok: true;
  /** False on a first load, which is what routes the creator into onboarding. */
  exists: boolean;
  source: VoiceProfileSource;
  /** Null exactly when `exists` is false and nothing was distilled. */
  profile: VoiceProfile | null;
  /** Advisory notes (thin example set, more than six examples, and so on). */
  warnings: string[];
  /**
   * The common AI tells, sent so the editor can pre-seed an empty banned list
   * without the browser holding its own copy of the list.
   */
  seedBannedPhrases: string[];
  /** Present only on a distillation response. */
  meta?: {
    provider: string;
    model: string;
    latencyMs: number;
  };
}

/** The voice endpoints reuse the generate endpoint's error envelope verbatim. */
export type VoiceErrorBody = GenerateErrorBody;

export type VoiceResponseBody = VoiceProfileBody | VoiceErrorBody;

/** Re-exported so a client component gets the cap from the same module as the wire types. */
export { MAX_EXAMPLES } from "./voice.ts";
