import { HOOK_ANGLE_LABELS, type Hook } from "@/types/generation.ts";

import { CopyButton } from "./copy-button.tsx";

/**
 * The hook options, one per angle.
 *
 * The angle is shown as a human-readable label rather than the enum value the
 * schema carries, because the label is the reason to pick one: the creator is
 * choosing between "Contrarian" and "Curiosity gap", not between
 * `contrarian` and `curiosity_gap`.
 */
export function HookList({ hooks }: { hooks: Hook[] }) {
  return (
    <section aria-labelledby="hooks-heading" className="flex flex-col gap-3">
      <h2 id="hooks-heading" className="text-lg font-semibold tracking-tight">
        Hooks <span className="text-zinc-500">({hooks.length})</span>
      </h2>

      <ol className="flex flex-col gap-3">
        {hooks.map((hook, index) => (
          <li
            key={`${hook.angle}-${index}`}
            className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-2">
                <span className="w-fit rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] uppercase tracking-wide text-zinc-400">
                  {HOOK_ANGLE_LABELS[hook.angle] ?? hook.angle}
                </span>
                <p className="text-base leading-relaxed text-zinc-100">{hook.text}</p>
                <p className="text-sm text-zinc-500">{hook.rationale}</p>
              </div>
              <CopyButton text={hook.text} label="Copy hook" />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
