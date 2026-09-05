import { describe, expect, it, vi } from "vitest";

import { MAX_ATTEMPTS, runGeneration } from "@/lib/api/generate-service.ts";
import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import {
  LlmRateLimitError,
  LlmRefusalError,
  LlmSchemaError,
  LlmTruncatedError,
} from "@/lib/llm/errors.ts";
import type { LlmAdapter, StructuredRequest, StructuredResult } from "@/lib/llm/types.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";

/**
 * The retry is bounded on purpose: once absorbs a one-off malformed response,
 * twice would let a structurally impossible request burn tokens unattended.
 * These tests pin both halves of that — that it retries, and that it stops.
 */

/** Fails the first `failuresBeforeSuccess` calls, then delegates to the fixtures. */
class FlakyAdapter implements LlmAdapter {
  readonly provider = "mock" as const;
  readonly model = "mock-fixture-model";
  calls = 0;

  private readonly inner = new MockAdapter();
  private readonly failuresBeforeSuccess: number;
  private readonly error: () => Error;

  // No parameter properties anywhere in this repo: `erasableSyntaxOnly` is on,
  // because modules under `lib/` are loaded by Node's type stripping.
  constructor(failuresBeforeSuccess: number, error: () => Error) {
    this.failuresBeforeSuccess = failuresBeforeSuccess;
    this.error = error;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls += 1;
    if (this.calls <= this.failuresBeforeSuccess) throw this.error();
    return this.inner.generateStructured(req);
  }
}

describe("runGeneration", () => {
  it("returns a success body carrying the normalised idea and profile provenance", async () => {
    const body = await runGeneration({
      idea: `  ${SAMPLE_IDEA}  `,
      hookCount: 3,
      adapter: new MockAdapter(),
    });

    expect(body.ok).toBe(true);
    expect(body.idea).toBe(SAMPLE_IDEA);
    expect(body.hooks).toHaveLength(3);
    expect(body.script.sections.length).toBeGreaterThan(0);
    expect(typeof body.meta.usedExampleProfile).toBe("boolean");
  });

  it("retries once when the first attempt produces an unusable structure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // One failure: the hooks call of attempt 1. Attempt 2 runs both calls clean.
    const adapter = new FlakyAdapter(1, () => new LlmSchemaError("four hooks, not five"));

    const body = await runGeneration({ idea: SAMPLE_IDEA, hookCount: 3, adapter });

    expect(body.ok).toBe(true);
    expect(adapter.calls).toBe(3); // failed hooks call, then hooks + script
    warn.mockRestore();
  });

  it("retries a truncated response too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new FlakyAdapter(1, () => new LlmTruncatedError("cut off"));

    await expect(
      runGeneration({ idea: SAMPLE_IDEA, hookCount: 3, adapter }),
    ).resolves.toMatchObject({ ok: true });
    warn.mockRestore();
  });

  it("gives up after exactly one retry and rethrows for the route to map to 422", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new FlakyAdapter(Number.MAX_SAFE_INTEGER, () =>
      new LlmSchemaError("still wrong"),
    );

    await expect(
      runGeneration({ idea: SAMPLE_IDEA, hookCount: 3, adapter }),
    ).rejects.toBeInstanceOf(LlmSchemaError);

    expect(adapter.calls).toBe(MAX_ATTEMPTS);
    warn.mockRestore();
  });

  it("does not retry a refusal — a re-ask returns the same refusal", async () => {
    const adapter = new FlakyAdapter(Number.MAX_SAFE_INTEGER, () =>
      new LlmRefusalError("declined"),
    );

    await expect(
      runGeneration({ idea: SAMPLE_IDEA, hookCount: 3, adapter }),
    ).rejects.toBeInstanceOf(LlmRefusalError);

    expect(adapter.calls).toBe(1);
  });

  it("does not retry a rate limit — that needs a wait, not a second hit", async () => {
    const adapter = new FlakyAdapter(Number.MAX_SAFE_INTEGER, () =>
      new LlmRateLimitError("slow down", 12),
    );

    await expect(
      runGeneration({ idea: SAMPLE_IDEA, hookCount: 3, adapter }),
    ).rejects.toBeInstanceOf(LlmRateLimitError);

    expect(adapter.calls).toBe(1);
  });
});
