import { describe, expect, it } from "vitest";

import { badRequest, toApiError } from "@/lib/api/errors.ts";
import { GenerationInputError } from "@/lib/generate/idea.ts";
import { HookRequestError } from "@/lib/prompts/hooks.ts";
import {
  LlmConfigError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmSchemaError,
  LlmTruncatedError,
  LlmUpstreamError,
} from "@/lib/llm/errors.ts";
import { VoiceProfileError } from "@/lib/voice/store.ts";

/**
 * The error taxonomy is the point of the route: four failure modes that need
 * four different reactions from the person waiting on a script. Each mapping is
 * pinned so a refactor cannot quietly collapse them into a generic 500.
 */

describe("toApiError", () => {
  it("maps bad input to 400", () => {
    for (const error of [
      new GenerationInputError("idea too short"),
      new HookRequestError("hookCount out of range"),
    ]) {
      const mapped = toApiError(error);
      expect(mapped.status).toBe(400);
      expect(mapped.body.error.code).toBe("bad_request");
    }
  });

  it("maps a refusal to 422 and surfaces the model's explanation", () => {
    const mapped = toApiError(
      new LlmRefusalError("refused", "harmful", "This one is off limits."),
    );
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe("refused");
    expect(mapped.body.error.message).toContain("This one is off limits.");
  });

  it("maps a schema failure to 422 (it only reaches here after the retry)", () => {
    const mapped = toApiError(new LlmSchemaError("bad shape"));
    expect(mapped.status).toBe(422);
    expect(mapped.body.error.code).toBe("invalid_output");
  });

  it("maps a rate limit to 429 with retry-after in both the body and the header", () => {
    const mapped = toApiError(new LlmRateLimitError("slow down", 30));
    expect(mapped.status).toBe(429);
    expect(mapped.body.error.code).toBe("rate_limited");
    expect(mapped.body.error.retryAfterSeconds).toBe(30);
    expect(mapped.headers["retry-after"]).toBe("30");
    expect(mapped.body.error.message).toContain("30 second");
  });

  it("omits retry-after when the provider did not send one", () => {
    const mapped = toApiError(new LlmRateLimitError("slow down"));
    expect(mapped.status).toBe(429);
    expect(mapped.body.error.retryAfterSeconds).toBeUndefined();
    expect(mapped.headers["retry-after"]).toBeUndefined();
  });

  it("maps upstream failures and truncation to 502", () => {
    expect(toApiError(new LlmUpstreamError("boom", 503)).status).toBe(502);
    expect(toApiError(new LlmUpstreamError("boom", 503)).body.error.code).toBe("upstream");
    expect(toApiError(new LlmTruncatedError("cut off")).status).toBe(502);
  });

  it("maps our own misconfiguration to 500, not to the caller's fault", () => {
    expect(toApiError(new LlmConfigError("no fixture")).status).toBe(500);
    expect(
      toApiError(new VoiceProfileError("missing", "no profile", "data/x.json")).status,
    ).toBe(500);
  });

  it("never leaks an unknown error's message to the client", () => {
    const mapped = toApiError(new Error("ANTHROPIC_API_KEY=sk-secret is invalid"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("server_error");
    expect(mapped.body.error.message).not.toContain("sk-secret");
  });
});

describe("badRequest", () => {
  it("carries field-level detail when it has any", () => {
    const mapped = badRequest("idea is too short", ["idea: too short"]);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.details).toEqual(["idea: too short"]);
  });

  it("omits details entirely when there are none", () => {
    expect(badRequest("nope").body.error.details).toBeUndefined();
  });
});
