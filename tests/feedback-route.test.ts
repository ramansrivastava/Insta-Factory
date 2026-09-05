import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/feedback/route.ts";
import { readTraceRecords } from "@/lib/generations/store.ts";
import type { FeedbackSuccessBody } from "@/types/feedback.ts";

/**
 * Route-level coverage for POST /api/feedback.
 *
 * The writes are pointed at a temp directory: this is the one route that always
 * touches disk (a creator pressing a button is an explicit act, so it is not
 * gated on `GENERATION_TRACE`), and a test must never append to the real trace.
 */

const generationId = "d17bf0ff-56c5-4281-b92d-356d1ca0f3a9";

function post(body: unknown, raw?: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

const previousDir = process.env.GENERATIONS_DIR;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "feedback-route-"));
  process.env.GENERATIONS_DIR = dir;
});

afterAll(() => {
  if (previousDir === undefined) delete process.env.GENERATIONS_DIR;
  else process.env.GENERATIONS_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/feedback", () => {
  it("records a used_as_is hook and echoes the trace id back", async () => {
    const response = await post({
      generationId,
      target: "hook",
      hookIndex: 0,
      outcome: "used_as_is",
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as FeedbackSuccessBody;
    expect(body.ok).toBe(true);
    expect(body.generationId).toBe(generationId);
    expect(Number.isNaN(Date.parse(body.recordedAt))).toBe(false);

    const { records } = readTraceRecords({ dir });
    expect(records.at(-1)).toMatchObject({ type: "feedback", outcome: "used_as_is" });
  });

  it("records an edited hook together with the rewrite", async () => {
    const response = await post({
      generationId,
      target: "hook",
      hookIndex: 1,
      outcome: "edited",
      editedText: "What I actually said instead.",
    });
    expect(response.status).toBe(200);

    const { records } = readTraceRecords({ dir });
    expect(records.at(-1)).toMatchObject({
      outcome: "edited",
      edited_text: "What I actually said instead.",
    });
  });

  it("rejects an edited outcome with no rewrite instead of writing a hole in the trace", async () => {
    const before = readTraceRecords({ dir }).records.length;

    for (const body of [
      { generationId, target: "hook", hookIndex: 2, outcome: "edited" },
      { generationId, target: "hook", hookIndex: 2, outcome: "edited", editedText: "" },
      { generationId, target: "script", outcome: "edited", editedText: "   " },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await errorMessage(response)).toContain("editedText is required");
    }

    // Nothing was appended: a refused rating leaves the ground truth untouched.
    expect(readTraceRecords({ dir }).records).toHaveLength(before);
  });

  it("rejects an outcome outside the vocabulary, and a body with no generationId", async () => {
    const badOutcome = await post({ generationId, target: "script", outcome: "loved_it" });
    expect(badOutcome.status).toBe(400);
    expect(await errorMessage(badOutcome)).toContain("outcome:");

    const noId = await post({ target: "script", outcome: "discarded" });
    expect(noId.status).toBe(400);
  });

  it("rejects a body that is not JSON at all without falling over", async () => {
    const response = await post(undefined, "{not even json");
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toContain("must be JSON");
  });

  it("still accepts feedback against an unknown generationId, by design", async () => {
    // Verifying the id would make the cheapest click in the product the most
    // expensive request it serves; `generations:summary` counts orphans instead.
    const response = await post({
      generationId: "does-not-exist-ghost-id",
      target: "script",
      outcome: "discarded",
    });

    expect(response.status).toBe(200);
  });
});
