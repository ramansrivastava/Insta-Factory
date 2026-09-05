import type { LlmAdapter } from "../llm/types.ts";
import { SEED_BANNED_PHRASES } from "../voice/defaults.ts";
import { distillVoiceTraits, toDraftProfile } from "../voice/distill.ts";
import { VoiceProfileError, loadVoiceProfile, saveVoiceProfile } from "../voice/store.ts";
import { collectVoiceProfileWarnings } from "../../types/voice.ts";
import type { VoiceExample, VoiceProfile } from "../../types/voice.ts";
import type { VoiceProfileBody, VoiceProfileUpdate } from "../../types/voice-api.ts";

/**
 * The server-side half of `/api/voice`: read, write, distil.
 *
 * Phase 2 already owns persistence (`lib/voice/store.ts`) and distillation
 * (`lib/voice/distill.ts`); neither is reimplemented here. What this module
 * adds is the three things only an HTTP caller needs — a missing profile
 * expressed as `exists: false` rather than a thrown error, a serialisable
 * body, and the guarantee that distillation never writes anything.
 *
 * That last point is the load-bearing one. A distilled profile is the model's
 * read of the creator's voice, and the entire premise of this screen is that
 * the creator corrects it before it becomes real. So POST returns a draft and
 * only PUT touches the disk.
 */

export interface VoiceServiceOptions {
  /** Repo root the profile is read from and written to. Injected by tests. */
  root?: string;
  /** Explicit profile file, overriding `root`. Injected by tests. */
  path?: string;
}

export interface DistillServiceOptions extends VoiceServiceOptions {
  /** Injected by tests; production resolves the adapter from the environment. */
  adapter?: LlmAdapter;
  env?: Record<string, string | undefined>;
}

const seedBannedPhrases = (): string[] => [...SEED_BANNED_PHRASES];

/**
 * GET. A missing profile is the expected first-run state, not a failure, so it
 * comes back as `exists: false` with a null profile. Every other
 * `VoiceProfileError` — malformed JSON, a profile that no longer satisfies the
 * schema — still throws, because those mean a real file is in a state the
 * creator needs told about rather than silently replaced.
 *
 * Deliberately no `fallbackToExample`: the generator falls back so it can still
 * produce something, but an *editor* that quietly loaded a stranger's profile
 * would invite the creator to edit and save someone else's voice as their own.
 */
export function readVoiceProfile(options: VoiceServiceOptions = {}): VoiceProfileBody {
  try {
    const loaded = loadVoiceProfile({ root: options.root, path: options.path });
    return {
      ok: true,
      exists: true,
      source: "saved",
      profile: loaded.profile,
      warnings: loaded.warnings,
      seedBannedPhrases: seedBannedPhrases(),
    };
  } catch (error) {
    if (error instanceof VoiceProfileError && error.code === "missing") {
      return {
        ok: true,
        exists: false,
        source: "none",
        profile: null,
        warnings: [],
        seedBannedPhrases: seedBannedPhrases(),
      };
    }
    throw error;
  }
}

/** True when a valid profile is on disk. Drives the first-run redirect. */
export function voiceProfileExists(options: VoiceServiceOptions = {}): boolean {
  try {
    return readVoiceProfile(options).exists;
  } catch {
    // A malformed or schema-invalid file is not a reason to bounce someone
    // into onboarding — the editor is where they will see the actual error.
    return true;
  }
}

/**
 * PUT. Validation happens twice on purpose: the route checks the wire shape,
 * and `saveVoiceProfile` re-validates the full profile before writing, so the
 * example cap holds even if a future caller reaches this function directly.
 */
export function writeVoiceProfile(
  update: VoiceProfileUpdate,
  options: VoiceServiceOptions = {},
): VoiceProfileBody {
  const saved = saveVoiceProfile(
    {
      traits: update.traits,
      examples: update.examples,
      // Overwritten by `saveVoiceProfile`'s own stamp; present because the
      // profile type requires it, never because the value is meaningful.
      updated_at: new Date().toISOString(),
    },
    { root: options.root, path: options.path },
  );

  return {
    ok: true,
    exists: true,
    source: "saved",
    profile: saved.profile,
    warnings: saved.warnings,
    seedBannedPhrases: seedBannedPhrases(),
  };
}

/**
 * POST. One structured call, then a draft profile the creator reviews.
 *
 * The pasted samples become the draft's examples: they are the only writing of
 * the creator's the system has, and re-asking for them after distillation would
 * be asking the same question twice.
 */
export async function distillVoiceProfile(
  samples: readonly VoiceExample[],
  options: DistillServiceOptions = {},
): Promise<VoiceProfileBody> {
  const result = await distillVoiceTraits(
    samples.map((sample) => sample.text),
    { adapter: options.adapter, env: options.env },
  );

  // A profile that is on disk but unreadable must not lose the call that was
  // just paid for — the draft stands on its own, and the editor is where the
  // broken file gets surfaced.
  let existing: VoiceProfile | undefined;
  try {
    existing = readVoiceProfile(options).profile ?? undefined;
  } catch {
    existing = undefined;
  }

  // The pasted samples replace whatever examples were carried over: they are
  // what produced these traits.
  const draft: VoiceProfile = {
    ...toDraftProfile(result.traits, existing),
    examples: [...samples],
  };

  return {
    ok: true,
    exists: existing !== undefined,
    source: "draft",
    profile: draft,
    warnings: collectVoiceProfileWarnings(draft),
    seedBannedPhrases: seedBannedPhrases(),
    meta: {
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
    },
  };
}
