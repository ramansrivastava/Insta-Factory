import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recordFeedback } from "@/lib/api/feedback-service.ts";
import { readTraceRecords, traceFilePath } from "@/lib/generations/store.ts";
import {
  FeedbackRequestSchema,
  MAX_EDITED_TEXT_LENGTH,
  type FeedbackRequest,
} from "@/types/feedback.ts";

/**
 * The validation in front of `POST /api/feedback`, and the line it writes.
 *
 * This is the only ground truth the product will ever have about whether the
 * writing was any good, it is append-only, and it cannot be reconstructed after
 * the fact — so every branch that decides whether a rating is admitted or
 * refused is pinned here, not just the happy path.
 */

const generationId = "d17bf0ff-56c5-4281-b92d-356d1ca0f3a9";

function parse(body: unknown) {
  return FeedbackRequestSchema.safeParse(body);
}

/** The first message a rejection would put in the 400 body. */
function firstIssue(result: ReturnType<typeof parse>): string {
  if (result.success) throw new Error("expected the body to be rejected");
  const [issue] = result.error.issues;
  if (!issue) throw new Error("a rejection must carry at least one issue");
  return `${issue.path.map(String).join(".") || "<body>"}: ${issue.message}`;
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feedback-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("FeedbackRequestSchema — accepted feedback", () => {
  it("accepts a hook rated used_as_is", () => {
    const result = parse({
      generationId,
      target: "hook",
      hookIndex: 0,
      outcome: "used_as_is",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.hookIndex).toBe(0);
    expect(result.success && result.data.editedText).toBeUndefined();
  });

  it("accepts a discarded script, which carries no index and no text", () => {
    const result = parse({ generationId, target: "script", outcome: "discarded" });

    expect(result.success).toBe(true);
    expect(result.success && result.data.hookIndex).toBeUndefined();
  });

  it("accepts an edited hook that carries the rewrite, and trims it", () => {
    const result = parse({
      generationId: `  ${generationId}  `,
      target: "hook",
      hookIndex: 2,
      outcome: "edited",
      editedText: "  Two sessions a week beats the split you quit.  ",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.generationId).toBe(generationId);
    expect(result.success && result.data.editedText).toBe(
      "Two sessions a week beats the split you quit.",
    );
  });
});

describe("FeedbackRequestSchema — refused feedback", () => {
  it("refuses an edited outcome with no rewrite, which would be an unrepairable record", () => {
    const result = parse({ generationId, target: "hook", hookIndex: 1, outcome: "edited" });

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain("editedText is required");
  });

  it("refuses an edited outcome whose rewrite is only whitespace", () => {
    for (const editedText of ["", "   ", "\n\t "]) {
      const result = parse({
        generationId,
        target: "script",
        outcome: "edited",
        editedText,
      });

      expect(result.success).toBe(false);
      expect(firstIssue(result)).toContain("editedText is required");
    }
  });

  it("still allows an empty rewrite on the outcomes it means nothing for", () => {
    // Only `edited` promises a rewrite, so a stray empty field elsewhere is
    // noise rather than a hole in the data.
    const result = parse({
      generationId,
      target: "script",
      outcome: "discarded",
      editedText: "  ",
    });

    expect(result.success).toBe(true);
  });

  it("refuses an outcome outside the three-word vocabulary", () => {
    const result = parse({ generationId, target: "script", outcome: "loved_it" });

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain("outcome:");
  });

  it("refuses feedback with no generationId, which is an opinion about nothing", () => {
    expect(parse({ target: "script", outcome: "discarded" }).success).toBe(false);
    expect(
      firstIssue(parse({ generationId: "   ", target: "script", outcome: "discarded" })),
    ).toContain("generationId is required");
  });

  it("refuses a hookIndex that contradicts the target, in either direction", () => {
    expect(parse({ generationId, target: "hook", outcome: "used_as_is" }).success).toBe(false);
    expect(
      parse({ generationId, target: "script", hookIndex: 0, outcome: "used_as_is" }).success,
    ).toBe(false);
    expect(
      parse({ generationId, target: "hook", hookIndex: 99, outcome: "used_as_is" }).success,
    ).toBe(false);
  });

  it("refuses a rewrite longer than the API will store, and unknown keys", () => {
    const tooLong = parse({
      generationId,
      target: "script",
      outcome: "edited",
      editedText: "x".repeat(MAX_EDITED_TEXT_LENGTH + 1),
    });
    expect(tooLong.success).toBe(false);
    expect(firstIssue(tooLong)).toContain("at most");

    expect(
      parse({ generationId, target: "script", outcome: "discarded", mood: "grumpy" }).success,
    ).toBe(false);
  });
});

describe("recordFeedback", () => {
  const now = new Date("2026-09-05T07:06:04.669Z");

  function record(request: FeedbackRequest, dir: string) {
    const result = recordFeedback(request, { dir, now });
    const { records } = readTraceRecords({ dir });
    return { result, records };
  }

  it("appends one feedback line joined to the generation by id", () => {
    const dir = tempDir();
    const { result, records } = record(
      { generationId, target: "hook", hookIndex: 0, outcome: "used_as_is" },
      dir,
    );

    expect(result).toEqual({ ok: true, generationId, recordedAt: now.toISOString() });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "feedback",
      generation_id: generationId,
      recorded_at: now.toISOString(),
      target: "hook",
      hook_index: 0,
      outcome: "used_as_is",
    });
    expect(records[0]).not.toHaveProperty("edited_text");
  });

  it("keeps the rewrite on an edited record, so the labelled pair survives", () => {
    const dir = tempDir();
    const { records } = record(
      {
        generationId,
        target: "hook",
        hookIndex: 1,
        outcome: "edited",
        editedText: "What I actually said instead.",
      },
      dir,
    );

    expect(records[0]).toMatchObject({
      outcome: "edited",
      edited_text: "What I actually said instead.",
    });
  });

  it("drops a rewrite that was abandoned for a discard", () => {
    const dir = tempDir();
    const { records } = record(
      {
        generationId,
        target: "script",
        outcome: "discarded",
        editedText: "half-written and thrown away",
      },
      dir,
    );

    expect(records[0]).not.toHaveProperty("edited_text");
    expect(records[0]).not.toHaveProperty("hook_index");
  });

  it("writes one parseable JSON line per rating, appending rather than replacing", () => {
    const dir = tempDir();
    recordFeedback({ generationId, target: "hook", hookIndex: 0, outcome: "used_as_is" }, {
      dir,
      now,
    });
    recordFeedback({ generationId, target: "script", outcome: "discarded" }, { dir, now });

    const lines = readFileSync(traceFilePath({ dir, now }), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
