"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with visible confirmation.
 *
 * The whole product is "write this, then go record it", so copying is the
 * primary action on every piece of output, not a convenience. It therefore has
 * to say whether it worked: `navigator.clipboard` is unavailable on insecure
 * origins and can be denied by permission, and a button that silently does
 * nothing in those cases is worse than no button.
 */

type CopyState = "idle" | "copied" | "failed";

const RESET_AFTER_MS = 1800;

export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function flash(next: CopyState) {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), RESET_AFTER_MS);
  }

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      flash("copied");
    } catch {
      flash("failed");
    }
  }

  const caption =
    state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        state === "copied"
          ? "border-emerald-500/50 text-emerald-300"
          : state === "failed"
            ? "border-red-500/50 text-red-300"
            : "border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
      } ${className}`}
    >
      {caption}
    </button>
  );
}
