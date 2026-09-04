import { NextResponse } from "next/server";

import { resolveModel, resolveProvider } from "@/lib/llm/index.ts";

// Provider and model are read from the environment at request time, so this
// route must never be prerendered at build time.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    provider: resolveProvider(),
    model: resolveModel(),
  });
}
