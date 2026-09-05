import { generationLogger } from "../log.ts";
import {
  appendTraceRecord,
  type FeedbackRecord,
  type TraceStoreOptions,
} from "../generations/store.ts";
import type { FeedbackRequest, FeedbackSuccessBody } from "../../types/feedback.ts";

/**
 * The server-side half of `POST /api/feedback`.
 *
 * It appends one line to the same daily JSONL file the generation itself was
 * written to, so a generation and everything the creator did with it live in
 * one place and join on `generation_id` with no index and no second store.
 *
 * There is deliberately no validation that the `generation_id` exists. The
 * alternative — scanning the trace files on every click — would make the
 * cheapest interaction in the product the most expensive request it serves, to
 * catch a case (a rating for a generation that was never written) that only
 * arises if tracing was switched off. `npm run generations:summary` reports
 * orphaned feedback instead, which is where noticing it actually matters.
 *
 * Unlike the automatic per-generation record, this write is not governed by
 * `GENERATION_TRACE`: a creator pressing a button is an explicit act, and
 * answering "recorded" while dropping it on the floor would be a lie. Point
 * `GENERATIONS_DIR` somewhere else if the default location is wrong.
 */

export class FeedbackWriteError extends Error {
  readonly path: string;

  constructor(message: string, file: string, cause?: unknown) {
    super(message);
    this.name = "FeedbackWriteError";
    this.path = file;
    this.cause = cause;
  }
}

/** Same knobs as the trace store: this writes to the same daily file. */
export type RecordFeedbackOptions = TraceStoreOptions;

export function recordFeedback(
  request: FeedbackRequest,
  options: RecordFeedbackOptions = {},
): FeedbackSuccessBody {
  const recordedAt = (options.now ?? new Date()).toISOString();

  const record: FeedbackRecord = {
    type: "feedback",
    generation_id: request.generationId,
    recorded_at: recordedAt,
    target: request.target,
    ...(request.hookIndex === undefined ? {} : { hook_index: request.hookIndex }),
    outcome: request.outcome,
    // Only kept on `edited`. A rewrite pasted in and then switched to
    // "discarded" is not a rewrite, and storing it would quietly corrupt the
    // one signal this record exists to carry.
    ...(request.outcome === "edited" && request.editedText
      ? { edited_text: request.editedText }
      : {}),
  };

  const outcome = appendTraceRecord(record, options);
  const log = generationLogger(request.generationId);

  if (!outcome.written) {
    throw new FeedbackWriteError(
      `Could not append feedback to ${outcome.file}.`,
      outcome.file,
      outcome.error,
    );
  }

  log.info(
    {
      event: "feedback.recorded",
      target: record.target,
      ...(record.hook_index === undefined ? {} : { hook_index: record.hook_index }),
      outcome: record.outcome,
      edited_chars: record.edited_text?.length ?? 0,
    },
    "feedback recorded",
  );

  return { ok: true, generationId: request.generationId, recordedAt };
}
