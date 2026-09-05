import { NextResponse } from "next/server";

import { badRequest, toApiError } from "@/lib/api/errors.ts";
import { runGeneration } from "@/lib/api/generate-service.ts";
import { errorFields, generationLogger, newGenerationId } from "@/lib/log.ts";
import { GenerateRequestSchema } from "@/types/api.ts";

/**
 * POST /api/generate — raw idea in, hooks plus a full script out.
 *
 * Non-streaming by design. A Reel script is a few hundred words, so streaming
 * would buy a second or two of perceived speed in exchange for partial-parse
 * handling on a payload that is only meaningful once its schema validates. It
 * also keeps this path byte-identical to the CLI and eval paths, which is what
 * makes the Layer-1 checks a real gate on what the UI shows.
 *
 * The `generation_id` is minted here, at the outermost edge of the request,
 * rather than deeper in the pipeline. That is what lets a body that never
 * parsed and a script that took nine seconds appear in the log as the same
 * shape of event, and it is the id the browser sends back with an
 * accept/edit/discard.
 */

// The provider is resolved from the environment per request and the voice
// profile is read from disk, so this route must never be prerendered.
export const dynamic = "force-dynamic";

// `lib/voice/store.ts` uses node:fs, so the edge runtime is not an option.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const generationId = newGenerationId();
  const log = generationLogger(generationId);
  log.info({ event: "request.received", route: "POST /api/generate" }, "request received");

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const { status, body } = badRequest(
      "The request body must be JSON shaped like {\"idea\": \"...\", \"hookCount\": 5}.",
    );
    log.warn({ event: "request.rejected", status, reason: "unparseable_body" }, "request rejected");
    return NextResponse.json(body, { status });
  }

  const parsed = GenerateRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<body>"}: ${issue.message}`,
    );
    const { status, body } = badRequest(
      details[0] ?? "The request body is not a valid generation request.",
      details,
    );
    log.warn(
      { event: "request.rejected", status, reason: "schema", details },
      "request rejected",
    );
    return NextResponse.json(body, { status });
  }

  try {
    const result = await runGeneration({
      idea: parsed.data.idea,
      hookCount: parsed.data.hookCount,
      generationId,
    });
    log.info(
      {
        event: "response.sent",
        status: 200,
        latency_ms: result.meta.latencyMs,
        cache_read_input_tokens: result.meta.cacheReadTokens,
      },
      "response sent",
    );
    return NextResponse.json(result);
  } catch (thrown) {
    // Logged in full server-side; the client gets the typed, human-readable
    // half so a provider stack trace never reaches the browser.
    const { status, body, headers } = toApiError(thrown);
    log.error(
      { event: "response.sent", status, code: body.error.code, err: errorFields(thrown) },
      "error response sent",
    );
    return NextResponse.json(body, { status, headers });
  }
}
