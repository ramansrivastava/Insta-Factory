import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/generate/route.ts";
import { SAMPLE_IDEA } from "@/lib/generate/sample.ts";
import { MIN_IDEA_LENGTH } from "@/lib/generate/idea.ts";
import { HookSchema, ScriptSchema, MAX_HOOKS } from "@/types/generation.ts";
import type { GenerateErrorBody, GenerateSuccessBody } from "@/types/api.ts";

/**
 * Route-level coverage for POST /api/generate.
 *
 * The mock provider is pinned explicitly rather than left to environment
 * detection: this test asserts a *complete, schema-valid* response, and that
 * claim is only meaningful if the same fixtures answer every time.
 */

function post(body: unknown, raw?: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/generate", {
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

describe("POST /api/generate on the mock provider", () => {
  it("returns a complete, schema-valid hooks-and-script payload", async () => {
    const response = await post({ idea: SAMPLE_IDEA, hookCount: 4 });
    expect(response.status).toBe(200);

    const body = (await response.json()) as GenerateSuccessBody;
    expect(body.ok).toBe(true);
    expect(body.idea).toBe(SAMPLE_IDEA);
    expect(body.hookCount).toBe(4);

    // Every hook validates, and every angle differs — the schema alone does not
    // enforce distinctness, so it is asserted here.
    expect(body.hooks).toHaveLength(4);
    for (const hook of body.hooks) {
      expect(HookSchema.safeParse(hook).success).toBe(true);
    }
    expect(new Set(body.hooks.map((hook) => hook.angle)).size).toBe(4);

    const script = ScriptSchema.safeParse(body.script);
    expect(script.success).toBe(true);

    // "Complete" means the sections a Reel cannot ship without are all present.
    const kinds = body.script.sections.map((section) => section.kind);
    expect(kinds).toContain("hook");
    expect(kinds).toContain("body");
    expect(kinds).toContain("cta");

    expect(body.meta.provider).toBe("mock");
    expect(typeof body.meta.model).toBe("string");
    expect(typeof body.meta.latencyMs).toBe("number");
    expect(Array.isArray(body.meta.profileWarnings)).toBe(true);
  });

  it("defaults the hook count when it is omitted", async () => {
    const response = await post({ idea: SAMPLE_IDEA });
    expect(response.status).toBe(200);

    const body = (await response.json()) as GenerateSuccessBody;
    expect(body.hooks).toHaveLength(body.hookCount);
  });

  it("serves every hook count the UI offers", async () => {
    for (const hookCount of [3, 4, 5, 6]) {
      const response = await post({ idea: SAMPLE_IDEA, hookCount });
      expect(response.status).toBe(200);
      const body = (await response.json()) as GenerateSuccessBody;
      expect(body.hooks).toHaveLength(hookCount);
    }
  });
});

describe("POST /api/generate input validation", () => {
  it("rejects a body that is not JSON with 400", async () => {
    const response = await post(null, "not json at all");
    expect(response.status).toBe(400);

    const body = (await response.json()) as GenerateErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
  });

  it("rejects an idea below the minimum length with 400", async () => {
    const response = await post({ idea: "too short" });
    expect(response.status).toBe(400);

    const body = (await response.json()) as GenerateErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain(String(MIN_IDEA_LENGTH));
    expect(body.error.details?.[0]).toContain("idea");
  });

  it("rejects more hooks than there are angles with 400", async () => {
    const response = await post({ idea: SAMPLE_IDEA, hookCount: MAX_HOOKS + 1 });
    expect(response.status).toBe(400);

    const body = (await response.json()) as GenerateErrorBody;
    expect(body.error.code).toBe("bad_request");
  });

  it("rejects a non-integer hook count with 400", async () => {
    const response = await post({ idea: SAMPLE_IDEA, hookCount: 4.5 });
    expect(response.status).toBe(400);
  });

  it("rejects unknown fields rather than silently ignoring them", async () => {
    const response = await post({ idea: SAMPLE_IDEA, tone: "sassy" });
    expect(response.status).toBe(400);
  });
});
