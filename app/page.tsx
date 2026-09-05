import { GeneratorPanel } from "@/components/generate/generator-panel.tsx";
import { resolveModel, resolveProvider } from "@/lib/llm/index.ts";

/**
 * The one screen: a raw idea goes in, hook options and a full script come out.
 *
 * A server component so the resolved provider and model are read from the
 * environment on the server and handed down as props — the browser never needs
 * to know how the LLM client is configured, only what answered.
 */

// Provider and model are environment-dependent, so never prerender this.
export const dynamic = "force-dynamic";

export default function Home() {
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
      </header>

      <GeneratorPanel provider={resolveProvider()} model={resolveModel()} />
    </main>
  );
}
