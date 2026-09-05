import { ideaContains } from "@/lib/generate/checks.ts";
import type { Claim, Script } from "@/types/generation.ts";

/**
 * The two decisions the script view makes that are worth testing on their own:
 * which claims get the "unverified" marker, and what "Copy whole script" puts
 * on the clipboard.
 *
 * They sit in a `.ts` rather than beside the markup in `script-view.tsx`
 * because `tsconfig.json` sets `jsx: "preserve"` — Next.js owns the JSX
 * transform — and the test runner honours that, so importing a `.tsx` from a
 * test fails at parse time. Keeping the logic in a plain module means these
 * rules are covered without standing up a renderer to check a string.
 */

export const SECTION_LABELS: Record<string, string> = {
  hook: "Hook",
  setup: "Setup",
  body: "Body",
  payoff: "Payoff",
  cta: "CTA",
};

/** The label the UI shows for a section kind, falling back to the raw kind. */
export function sectionLabel(kind: string): string {
  return SECTION_LABELS[kind] ?? kind;
}

/**
 * A claim is unverified when its attribution does not hold up: either it quotes
 * nothing, or the span it quotes does not actually appear in the idea the
 * creator wrote.
 *
 * The second case is the one that fires in practice. `grounded_in` is a
 * required, non-empty field in the schema, so a blank one cannot survive
 * validation — but a model under pressure to attribute will happily quote a
 * span it invented, which is the same fabrication one level up and is exactly
 * what the visible marker exists to catch. Both conditions are checked because
 * the schema is not the only thing that can put a claim on this screen.
 *
 * `ideaContains` is the same comparison `lib/generate/checks.ts` uses for the
 * Layer-1 groundedness gate, so the marker and the eval can never disagree.
 */
export function isClaimUnverified(claim: Claim, idea: string): boolean {
  if (claim.grounded_in.trim().length === 0) return true;
  return !ideaContains(idea, claim.grounded_in);
}

/** What gets copied by "Copy whole script" — the spoken lines, in order. */
export function renderScriptForClipboard(script: Script): string {
  return script.sections
    .map((section) => {
      const onScreen = section.on_screen_text
        ? `\n[on screen: ${section.on_screen_text}]`
        : "";
      return `${sectionLabel(section.kind).toUpperCase()}\n${section.text}${onScreen}`;
    })
    .join("\n\n");
}
