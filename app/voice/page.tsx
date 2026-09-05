import Link from "next/link";

import { VoiceEditor } from "@/components/voice/voice-editor.tsx";
import { readVoiceProfile } from "@/lib/api/voice-service.ts";
import { VOICE_PROFILE_FILE, VoiceProfileError } from "@/lib/voice/store.ts";
import type { VoiceProfileBody } from "@/types/voice-api.ts";

/**
 * `/voice` — the voice profile, as a screen rather than a JSON file.
 *
 * A server component so the profile is read on the server and handed down as
 * the editor's initial state: no loading flash, no second round trip, and the
 * `exists` flag that drives onboarding is decided in one place.
 */

// Reads the profile from disk per request, so never prerender.
export const dynamic = "force-dynamic";

export default async function VoicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const onboarding = params.onboarding === "1";

  let initial: VoiceProfileBody;
  try {
    initial = readVoiceProfile();
  } catch (error) {
    return <BrokenProfile error={error} />;
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Your voice</h1>
        <p className="text-zinc-400">
          A voice profile is a few distilled traits plus a handful of your own
          captions. Generation reads it on every call — this page is where you
          decide what it says.
        </p>
        <Link
          href="/"
          className="w-fit text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-300"
        >
          ← Back to the generator
        </Link>
      </header>

      <VoiceEditor initial={initial} onboarding={onboarding} />
    </main>
  );
}

/**
 * A profile that exists but does not parse is not an empty state — silently
 * offering a blank editor over it would invite the creator to overwrite work
 * they still have. So the file is named, the error is quoted, and the fix is
 * theirs to make.
 */
function BrokenProfile({ error }: { error: unknown }) {
  const message =
    error instanceof VoiceProfileError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Your voice</h1>
      <div
        role="alert"
        className="rounded-lg border border-red-500/50 bg-red-500/5 px-4 py-3 text-sm"
      >
        <p className="font-medium text-red-200">
          <code className="font-mono">{VOICE_PROFILE_FILE}</code> exists but could not be
          read as a voice profile.
        </p>
        <p className="mt-1 text-red-300/80">{message}</p>
        <p className="mt-2 text-red-300/80">
          Fix or delete that file and reload. It is left alone until you do —
          nothing here overwrites a profile it cannot read.
        </p>
      </div>
    </main>
  );
}
