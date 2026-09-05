import { NextResponse } from "next/server";

import { badRequest, toApiError } from "@/lib/api/errors.ts";
import { recordFeedback } from "@/lib/api/feedback-service.ts";
import { errorFields, generationLogger, logger } from "@/lib/log.ts";
import { FeedbackRequestSchema } from "@/types/feedback.ts";

/**
 * `POST /api/feedback` — what the creator actually did with a hook or a script.
 *
 * Layer 3 of the eval strategy. Three outcomes, one optional rewrite, no free
 * text: the point is that this is one click on the way to recording, because a
 * feedback surface with any friction at all is a feedback surface that collects
 * nothing after the first week.
 *
 * Fire-and-forget from the browser's side — the UI shows the choice as taken
 * immediately and does not block on this. So the response is thin on purpose;
 * what matters is that the line reached disk, and that a failure to reach disk
 * is a loud 500 rather than a shrug.
 */

// Writes to data/generations/ at request time.
export const dynamic = "force-dynamic";

// `lib/generations/store.ts` uses node:fs, so the edge runtime is not an option.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const { status, body } = badRequest(
      'The request body must be JSON shaped like {"generationId": "...", "target": "hook", "hookIndex": 0, "outcome": "used_as_is"}.',
    );
    logger.warn(
      { event: "request.rejected", route: "POST /api/feedback", status, reason: "unparseable_body" },
      "feedback request rejected",
    );
    return NextResponse.json(body, { status });
  }

  const parsed = FeedbackRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "<body>"}: ${issue.message}`,
    );
    const { status, body } = badRequest(
      details[0] ?? "That is not a valid piece of feedback.",
      details,
    );
    logger.warn(
      { event: "request.rejected", route: "POST /api/feedback", status, reason: "schema", details },
      "feedback request rejected",
    );
    return NextResponse.json(body, { status });
  }

  const log = generationLogger(parsed.data.generationId);

  try {
    const result = recordFeedback(parsed.data);
    log.info(
      { event: "response.sent", route: "POST /api/feedback", status: 200 },
      "feedback response sent",
    );
    return NextResponse.json(result);
  } catch (thrown) {
    const { status, body, headers } = toApiError(thrown);
    log.error(
      {
        event: "response.sent",
        route: "POST /api/feedback",
        status,
        code: body.error.code,
        err: errorFields(thrown),
      },
      "feedback error response sent",
    );
    return NextResponse.json(body, { status, headers });
  }
}
