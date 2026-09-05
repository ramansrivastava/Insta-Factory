import Link from "next/link";
import { redirect } from "next/navigation";

import { GeneratorPanel } from "@/components/generate/generator-panel.tsx";
import { voiceProfileExists } from "@/lib/api/voice-service.ts";
import { resolveModel, resolveProvider } from "@/lib/llm/index.ts";
import {
  VOICE_SETUP_PATH,
  isSkipVoiceSetupRequested,
  shouldRedirectToVoiceSetup,
} from "@/lib/voice/onboarding.ts";

/**
 * The one screen: a raw idea goes in, hook options and a full script come out.
 *
 * A server component so the resolved provider and model are read from the
 * environment on the server and handed down as props — the browser never needs
 * to know how the LLM client is configured, only what answered.
 *
 * With no voice profile on disk this screen is not the right first one: it
 * would generate in the example profile's voice, and "this does not sound like
 * me" is the worst possible first impression for a tool whose whole claim is
 * the opposite. So a profile-less first load is sent to `/voice` instead —
 * with `?skipVoiceSetup=1` available for anyone who wants to look around first.
 */

// Provider and model are environment-dependent, so never prerender this.
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  if (
    shouldRedirectToVoiceSetup({
      profileExists: voiceProfileExists(),
      skipRequested: isSkipVoiceSetupRequested(params),
    })
  ) {
    redirect(VOICE_SETUP_PATH);
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Instagram Creator OS
        </h1>
        <p className="text-zinc-400">
          Write the idea in your own words. You get hook options on different
          angles and a full Reel script, written in your voice — not a preset
          tone.
        </p>
        <Link
          href="/voice"
          className="w-fit text-sm text-zinc-500 underline underline-offset-4 hover:text-zinc-300"
        >
          Edit your voice profile →
        </Link>
      </header>

      <GeneratorPanel provider={resolveProvider()} model={resolveModel()} />
    </main>
  );
}
