import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import { LlmConfigError, LlmSchemaError } from "@/lib/llm/errors.ts";
import { ProbeSchema, buildProbeRequest } from "@/lib/llm/probe.ts";
import type { StructuredRequest } from "@/lib/llm/types.ts";

describe("MockAdapter", () => {
  it("returns the on-disk fixture for a request kind", async () => {
    const adapter = new MockAdapter();
    const result = await adapter.generateStructured(buildProbeRequest());

    expect(result.provider).toBe("mock");
    expect(result.data.ok).toBe(true);
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(ProbeSchema.safeParse(result.data).success).toBe(true);
  });

  it("is deterministic across calls", async () => {
    const adapter = new MockAdapter();
    const first = await adapter.generateStructured(buildProbeRequest());
    const second = await adapter.generateStructured(buildProbeRequest());

    expect(second).toEqual(first);
    expect(first.latencyMs).toBe(0);
    expect(first.usage.cacheReadInputTokens).toBe(0);
  });

  it("rejects a fixture that does not match the schema", async () => {
    const adapter = new MockAdapter({ fixtures: { probe: { ok: false } } });

    await expect(adapter.generateStructured(buildProbeRequest())).rejects.toBeInstanceOf(
      LlmSchemaError,
    );
  });

  it("reports a missing fixture as a config error", async () => {
    const adapter = new MockAdapter();
    const request: StructuredRequest<{ a: string }> = {
      ...buildProbeRequest(),
      kind: "definitely-not-a-fixture",
      schema: z.object({ a: z.string() }),
    };

    await expect(adapter.generateStructured(request)).rejects.toBeInstanceOf(
      LlmConfigError,
    );
  });

  it("refuses a request kind that could escape the fixture directory", async () => {
    const adapter = new MockAdapter();
    const request = { ...buildProbeRequest(), kind: "../../package" };

    await expect(adapter.generateStructured(request)).rejects.toBeInstanceOf(
      LlmConfigError,
    );
  });
});
