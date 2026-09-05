/**
 * First-run routing: with no voice profile on disk, the generator is the wrong
 * first screen.
 *
 * The product's whole claim is "written in your voice". Landing a new user on
 * an idea box would generate in the committed example profile's voice — a
 * stranger's — and the most likely reading of that output is "this tool does
 * not actually sound like me". So the first load goes to `/voice` instead.
 *
 * The decision is a pure function here rather than an `if` inside the page so
 * it can be tested without rendering, and so the escape hatch cannot be
 * accidentally dropped: a redirect with no way past it would trap anyone who
 * just wants to try the thing before pasting their captions.
 */

/** Where a profile-less first load is sent. */
export const VOICE_SETUP_PATH = "/voice?onboarding=1";

/** `/?skipVoiceSetup=1` bypasses the redirect for this load. */
export const SKIP_VOICE_SETUP_PARAM = "skipVoiceSetup";

export interface OnboardingDecisionInput {
  /** True when `data/voice-profile.json` exists and validates. */
  profileExists: boolean;
  /** True when the caller asked to go straight to the generator anyway. */
  skipRequested: boolean;
}

export function shouldRedirectToVoiceSetup({
  profileExists,
  skipRequested,
}: OnboardingDecisionInput): boolean {
  if (profileExists) return false;
  return !skipRequested;
}

/** Reads the bypass flag out of a Next.js `searchParams` bag. */
export function isSkipVoiceSetupRequested(
  params: Record<string, string | string[] | undefined> | undefined,
): boolean {
  const raw = params?.[SKIP_VOICE_SETUP_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1" || value === "true";
}
