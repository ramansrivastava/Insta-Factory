import { NextResponse } from "next/server";

import { badRequest, toApiError } from "@/lib/api/errors.ts";
import {
  distillVoiceProfile,
  readVoiceProfile,
  writeVoiceProfile,
} from "@/lib/api/voice-service.ts";
import {
  VoiceDistillRequestSchema,
  VoiceProfileUpdateSchema,
} from "@/types/voice-api.ts";

/**
 * `/api/voice` — the voice profile as a resource.
 *
 * - `GET`  the saved profile, or `exists: false` on a first run.
 * - `PUT`  a corrected profile. Validated, then written.
 * - `POST` pasted samples, distilled into a draft. Writes nothing.
 *
 * The split between PUT and POST is the product decision, not a REST habit:
 * distillation produces the model's guess at the creator's voice, and that
 * guess only becomes the profile once a human has looked at it and pressed
 * save. Nothing here writes on the creator's behalf.
 */

// The profile is read from disk and the provider from the environment, so this
// route must never be prerendered.
export const dynamic = "force-dynamic";

// `lib/voice/store.ts` uses node:fs, so the edge runtime is not an option.
export const runtime = "nodejs";

/** Turns Zod issues into the `details` array the UI renders under the message. */
function issueDetails(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map(
    (issue) => `${issue.path.map(String).join(".") || "<body>"}: ${issue.message}`,
  );
}

/**
 * `{ parsed: false }` rather than a sentinel value: `null` and `undefined` are
 * both legitimate JSON bodies that the schema should reject on its own terms.
 */
async function readJsonBody(
  request: Request,
): Promise<{ parsed: true; value: unknown } | { parsed: false }> {
  try {
    return { parsed: true, value: await request.json() };
  } catch {
    return { parsed: false };
  }
}

export function GET(): Response {
  try {
    return NextResponse.json(readVoiceProfile());
  } catch (thrown) {
    console.error("[api/voice GET]", thrown);
    const { status, body, headers } = toApiError(thrown);
    return NextResponse.json(body, { status, headers });
  }
}

export async function PUT(request: Request): Promise<Response> {
  const payload = await readJsonBody(request);
  if (!payload.parsed) {
    const { status, body } = badRequest(
      'The request body must be JSON shaped like {"traits": {...}, "examples": [...]}.',
    );
    return NextResponse.json(body, { status });
  }

  const parsed = VoiceProfileUpdateSchema.safeParse(payload.value);
  if (!parsed.success) {
    const details = issueDetails(parsed.error);
    const { status, body } = badRequest(
      details[0] ?? "That is not a valid voice profile.",
      details,
    );
    return NextResponse.json(body, { status });
  }

  try {
    return NextResponse.json(writeVoiceProfile(parsed.data));
  } catch (thrown) {
    console.error("[api/voice PUT]", thrown);
    const { status, body, headers } = toApiError(thrown);
    return NextResponse.json(body, { status, headers });
  }
}

export async function POST(request: Request): Promise<Response> {
  const payload = await readJsonBody(request);
  if (!payload.parsed) {
    const { status, body } = badRequest(
      'The request body must be JSON shaped like {"samples": [{"type": "caption", "text": "..."}]}.',
    );
    return NextResponse.json(body, { status });
  }

  const parsed = VoiceDistillRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    const details = issueDetails(parsed.error);
    const { status, body } = badRequest(
      details[0] ?? "Those samples cannot be distilled.",
      details,
    );
    return NextResponse.json(body, { status });
  }

  try {
    return NextResponse.json(await distillVoiceProfile(parsed.data.samples));
  } catch (thrown) {
    console.error("[api/voice POST]", thrown);
    const { status, body, headers } = toApiError(thrown);
    return NextResponse.json(body, { status, headers });
  }
}
