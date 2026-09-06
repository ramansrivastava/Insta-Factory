import { NextResponse } from "next/server";

import { badRequest, toApiError } from "@/lib/api/errors.ts";
import { runRegeneration } from "@/lib/api/generate-service.ts";
import { errorFields, generationLogger, newGenerationId } from "@/lib/log.ts";
import { RegenerateRequestSchema } from "@/types/api.ts";

/**
 * POST /api/regenerate — re-run one half of a generation.
 *
 * A sibling of `/api/generate` rather than a flag on it. The two requests carry
 * different bodies (this one needs a parent id, the hooks on screen and an
 * optional steer), return different bodies (one half, plus the checks that half
 * could answer), and mean different things in the trace. Folding them together
 * would have produced one handler with two mutually exclusive halves and a
 * response type nobody could narrow.
 *
 * The `generation_id` minted here is for the *new* run. A regeneration is a new
 * generation that names its parent — it never overwrites the record of the
 * attempt the creator rejected, because "she had to ask twice" is exactly the
 * signal this phase exists to make countable.
 */

export const dynamic = "force-dynamic";

// `lib/voice/store.ts` uses node:fs, so the edge runtime is not an option.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const generationId = newGenerationId();
  const log = generationLogger(generationId);
  log.info({ event: "request.received", route: "POST /api/regenerate" }, "request received");

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const { status, body } = badRequest(
      "The request body must be JSON shaped like {\"target\": \"hooks\", \"idea\": \"...\", \"parentGenerationId\": \"...\", \"hooks\": []}.",
    );
    log.warn({ event: "request.rejected", status, reason: "unparseable_body" }, "request rejected");
    return NextResponse.json(body, { status });
  }

  const parsed = RegenerateRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "<body>"}: ${issue.message}`,
    );
    const { status, body } = badRequest(
      details[0] ?? "The request body is not a valid regeneration request.",
      details,
    );
    log.warn(
      { event: "request.rejected", status, reason: "schema", details },
      "request rejected",
    );
    return NextResponse.json(body, { status });
  }

  try {
    const result = await runRegeneration({
      target: parsed.data.target,
      idea: parsed.data.idea,
      hookCount: parsed.data.hookCount,
      parentGenerationId: parsed.data.parentGenerationId,
      hooks: parsed.data.hooks,
      steer: parsed.data.steer,
      generationId,
    });
    log.info(
      {
        event: "response.sent",
        status: 200,
        target: result.target,
        parent_generation_id: result.meta.parentGenerationId,
        latency_ms: result.meta.latencyMs,
        cache_read_input_tokens: result.meta.cacheReadTokens,
      },
      "response sent",
    );
    return NextResponse.json(result);
  } catch (thrown) {
    const { status, body, headers } = toApiError(thrown);
    log.error(
      { event: "response.sent", status, code: body.error.code, err: errorFields(thrown) },
      "error response sent",
    );
    return NextResponse.json(body, { status, headers });
  }
}
