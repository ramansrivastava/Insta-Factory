import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/regenerate/route.ts";
import { runRegeneration } from "@/lib/api/generate-service.ts";
import { MockAdapter } from "@/lib/llm/adapters/mock.ts";
import { LlmSchemaError } from "@/lib/llm/errors.ts";
import type { LlmAdapter, StructuredRequest, StructuredResult } from "@/lib/llm/types.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import { HookSchema, MAX_STEER_LENGTH, ScriptSchema } from "@/types/generation.ts";
import type { GenerateErrorBody, RegenerateSuccessBody } from "@/types/api.ts";

/**
 * POST /api/regenerate, and the service behind it.
 *
 * The route is a sibling of `/api/generate` rather than a flag on it, so it
 * gets its own coverage rather than a case in that file: the body it accepts,
 * the body it returns and the failures it has to describe are all different.
 * What is asserted here is mostly what it *refuses* — a regeneration is the
 * creator's second ask, and a confusing rejection at that moment is worse than
 * at the first.
 */

const HOOKS = [
  {
    text: "You don't need five days a week. You need two you'll actually keep.",
    angle: "contrarian" as const,
    rationale: "Contradicts the split-first belief the audience already holds.",
  },
  {
    text: "Week three, and the split I saved is still sitting there untouched.",
    angle: "story_cold_open" as const,
    rationale: "Drops into the moment the idea describes, present tense.",
  },
  {
    text: "The program isn't the problem. The version of you who had six free hours is.",
    angle: "pain_point" as const,
    rationale: "Names the frustration the viewer is living in without blaming them.",
  },
];

function post(body: unknown, raw?: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/regenerate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

const previousProvider = process.env.LLM_PROVIDER;

beforeAll(() => {
  process.env.LLM_PROVIDER = "mock";
});

afterAll(() => {
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
});

describe("POST /api/regenerate on the mock provider", () => {
  it("returns new hooks, no script, and the parent it was launched from", async () => {
    const response = await post({
      target: "hooks",
      idea: SAMPLE_IDEA,
      hookCount: 4,
      parentGenerationId: "gen-parent",
      hooks: HOOKS,
      steer: "make them blunter",
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as RegenerateSuccessBody;
    expect(body.ok).toBe(true);
    expect(body.target).toBe("hooks");
    expect(body.script).toBeNull();
    expect(body.hooks).toHaveLength(4);
    for (const hook of body.hooks!) {
      expect(HookSchema.safeParse(hook).success).toBe(true);
    }
    expect(body.meta.parentGenerationId).toBe("gen-parent");
    expect(body.meta.generationId).not.toBe("gen-parent");
    expect(body.checks.map((check) => check.name)).not.toContain("section_completeness");
  });

  it("returns a new script, no hooks, and the checks a script can answer", async () => {
    const response = await post({
      target: "script",
      idea: SAMPLE_IDEA,
      hookCount: 3,
      parentGenerationId: "gen-parent",
      hooks: HOOKS,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as RegenerateSuccessBody;
    expect(body.target).toBe("script");
    expect(body.hooks).toBeNull();
    expect(ScriptSchema.safeParse(body.script).success).toBe(true);
    expect(body.checks.map((check) => check.name)).toEqual([
      "banned_phrases",
      "section_completeness",
      "groundedness",
    ]);
  });

  it("rejects a body that is not JSON at all", async () => {
    const response = await post(null, "not json");
    expect(response.status).toBe(400);
    expect(((await response.json()) as GenerateErrorBody).error.code).toBe("bad_request");
  });

  it("rejects a script regeneration with no hooks to open with", async () => {
    const response = await post({
      target: "script",
      idea: SAMPLE_IDEA,
      hookCount: 3,
      parentGenerationId: "gen-parent",
      hooks: [],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as GenerateErrorBody;
    expect(body.error.message.toLowerCase()).toContain("hooks");
  });

  it("rejects a missing parent id — an unparented regeneration is not countable", async () => {
    const response = await post({
      target: "hooks",
      idea: SAMPLE_IDEA,
      hookCount: 3,
      hooks: HOOKS,
    });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown target rather than guessing which half to re-run", async () => {
    const response = await post({
      target: "everything",
      idea: SAMPLE_IDEA,
      hookCount: 3,
      parentGenerationId: "gen-parent",
      hooks: HOOKS,
    });
    expect(response.status).toBe(400);
  });

  it("rejects a steer that has grown into a brief", async () => {
    const response = await post({
      target: "hooks",
      idea: SAMPLE_IDEA,
      hookCount: 3,
      parentGenerationId: "gen-parent",
      hooks: HOOKS,
      steer: "x".repeat(MAX_STEER_LENGTH + 1),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as GenerateErrorBody;
    expect(body.error.message).toContain(String(MAX_STEER_LENGTH));
  });
});

/** Fails the first call, then delegates to the fixtures. */
class FlakyAdapter implements LlmAdapter {
  readonly provider = "mock" as const;
  readonly model = "mock-fixture-model";
  calls = 0;

  private readonly inner = new MockAdapter();

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls += 1;
    if (this.calls === 1) throw new LlmSchemaError("four hooks, not five");
    return this.inner.generateStructured(req);
  }
}

describe("runRegeneration", () => {
  it("retries once, so a malformed response does not cost a third button press", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new FlakyAdapter();

    const body = await runRegeneration({
      target: "hooks",
      idea: SAMPLE_IDEA,
      hookCount: 3,
      parentGenerationId: "gen-parent",
      hooks: HOOKS,
      adapter,
    });

    expect(body.ok).toBe(true);
    expect(adapter.calls).toBe(2);
    expect(typeof body.meta.usedExampleProfile).toBe("boolean");
    warn.mockRestore();
  });

  it("normalises the idea it echoes back, so the client stores what was generated from", async () => {
    const body = await runRegeneration({
      target: "hooks",
      idea: `  ${SAMPLE_IDEA}  `,
      hookCount: 3,
      parentGenerationId: "gen-parent",
      hooks: HOOKS,
      adapter: new MockAdapter(),
    });

    expect(body.idea).toBe(SAMPLE_IDEA);
  });
});
