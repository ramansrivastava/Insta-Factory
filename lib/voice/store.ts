import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  VoiceProfileSchema,
  collectVoiceProfileWarnings,
  type VoiceProfile,
  type VoiceProfileInput,
} from "../../types/voice.ts";

/**
 * Persistence for the voice profile.
 *
 * The profile is one small JSON file the creator is expected to open and edit
 * by hand — that is deliberate (Jasper and Copy.ai both distil samples into a
 * legible, user-correctable profile rather than a black box). So every failure
 * mode here is a *typed* error carrying the offending path, not a bare
 * `ENOENT` bubbling out of `fs`.
 *
 * No TypeScript parameter properties in this file: modules under `lib/` are
 * loaded directly by Node's type stripping from `scripts/`, which accepts only
 * erasable syntax.
 */

export const VOICE_PROFILE_FILE = "data/voice-profile.json";
export const VOICE_PROFILE_EXAMPLE_FILE = "data/voice-profile.example.json";

export function voiceProfilePath(root: string = process.cwd()): string {
  return path.join(root, VOICE_PROFILE_FILE);
}

export function voiceProfileExamplePath(root: string = process.cwd()): string {
  return path.join(root, VOICE_PROFILE_EXAMPLE_FILE);
}

export type VoiceProfileErrorCode =
  /** The file is not there at all. */
  | "missing"
  /** The file exists but is not parseable JSON. */
  | "malformed"
  /** Valid JSON, but it does not satisfy the schema (bad field, >10 examples). */
  | "invalid"
  /** Present and parseable, but the filesystem refused the read. */
  | "unreadable"
  /** The write failed. */
  | "write_failed";

export class VoiceProfileError extends Error {
  readonly code: VoiceProfileErrorCode;
  readonly path: string | null;
  readonly cause?: unknown;

  constructor(
    code: VoiceProfileErrorCode,
    message: string,
    profilePath: string | null = null,
    cause?: unknown,
  ) {
    super(message);
    this.name = "VoiceProfileError";
    this.code = code;
    this.path = profilePath;
    this.cause = cause;
  }
}

export interface LoadedVoiceProfile {
  profile: VoiceProfile;
  /** Advisory, never fatal — see `collectVoiceProfileWarnings`. */
  warnings: string[];
  /** Absolute path the profile was actually read from. */
  path: string;
  /** True when the committed example profile was used as a fallback. */
  usedExample: boolean;
}

export interface LoadVoiceProfileOptions {
  /** Explicit file to read. Defaults to `data/voice-profile.json` under `root`. */
  path?: string;
  root?: string;
  /**
   * When the real profile is missing, fall back to the committed example so a
   * fresh checkout can run the core loop before the creator has entered
   * anything. Off by default: silent fallbacks in the write path would be a
   * data-loss hazard.
   */
  fallbackToExample?: boolean;
}

/** Validates an already-parsed value. Throws `VoiceProfileError("invalid")`. */
export function parseVoiceProfile(
  raw: unknown,
  source: string | null = null,
): LoadedVoiceProfile {
  const parsed = VoiceProfileSchema.safeParse(raw);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new VoiceProfileError(
      "invalid",
      `Voice profile${source ? ` at ${source}` : ""} is not a valid profile — ${detail}`,
      source,
      parsed.error,
    );
  }

  return {
    profile: parsed.data,
    warnings: collectVoiceProfileWarnings(parsed.data),
    path: source ?? "",
    usedExample: false,
  };
}

export function loadVoiceProfile(
  options: LoadVoiceProfileOptions = {},
): LoadedVoiceProfile {
  const root = options.root ?? process.cwd();
  const primary = options.path ?? voiceProfilePath(root);

  let contents: string;
  let file = primary;
  let usedExample = false;

  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (!isNotFound(error)) {
      throw new VoiceProfileError(
        "unreadable",
        `Could not read the voice profile at ${file}: ${describe(error)}`,
        file,
        error,
      );
    }

    if (!options.fallbackToExample) {
      throw new VoiceProfileError(
        "missing",
        `No voice profile at ${file}. Copy ${VOICE_PROFILE_EXAMPLE_FILE} to ${VOICE_PROFILE_FILE} and edit it, or run \`npm run voice:distill\`.`,
        file,
      );
    }

    file = voiceProfileExamplePath(root);
    usedExample = true;
    try {
      contents = readFileSync(file, "utf8");
    } catch (fallbackError) {
      throw new VoiceProfileError(
        "missing",
        `No voice profile at ${primary}, and the committed example at ${file} is unreadable too.`,
        primary,
        fallbackError,
      );
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new VoiceProfileError(
      "malformed",
      `Voice profile at ${file} is not valid JSON: ${describe(error)}`,
      file,
      error,
    );
  }

  const loaded = parseVoiceProfile(raw, file);
  return { ...loaded, path: file, usedExample };
}

export interface SaveVoiceProfileOptions {
  path?: string;
  root?: string;
  /**
   * Overwrite `updated_at` with the current time. On by default — a saved
   * profile that claims a stale timestamp is worse than no timestamp.
   */
  stampUpdatedAt?: boolean;
}

/**
 * Validates, then writes pretty-printed JSON. Validation happens *before* the
 * write, so a rejected profile never truncates a good file on disk.
 */
export function saveVoiceProfile(
  profile: VoiceProfileInput | VoiceProfile,
  options: SaveVoiceProfileOptions = {},
): LoadedVoiceProfile {
  const root = options.root ?? process.cwd();
  const file = options.path ?? voiceProfilePath(root);

  const candidate =
    options.stampUpdatedAt === false
      ? profile
      : { ...profile, updated_at: new Date().toISOString() };

  const validated = parseVoiceProfile(candidate, file);

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(validated.profile, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new VoiceProfileError(
      "write_failed",
      `Could not write the voice profile to ${file}: ${describe(error)}`,
      file,
      error,
    );
  }

  return { ...validated, path: file, usedExample: false };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
