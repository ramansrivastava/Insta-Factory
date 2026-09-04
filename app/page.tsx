import { resolveModel, resolveProvider } from "@/lib/llm/index.ts";

export const dynamic = "force-dynamic";

export default function Home() {
  const provider = resolveProvider();
  const model = resolveModel();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-20">
      <h1 className="text-3xl font-semibold tracking-tight">Instagram Creator OS</h1>
      <p className="text-zinc-400">
        Scaffold is up. The idea &rarr; hooks + script generator lands in a later
        phase; for now this page confirms the app boots and the LLM adapter
        resolves.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-zinc-500">Provider</dt>
        <dd className="font-mono">{provider}</dd>
        <dt className="text-zinc-500">Model</dt>
        <dd className="font-mono">{model}</dd>
      </dl>
      <p className="text-sm text-zinc-500">
        Health endpoint: <code className="font-mono">/api/health</code>
      </p>
    </main>
  );
}
