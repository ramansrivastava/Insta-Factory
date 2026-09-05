import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET, POST, PUT } from "@/app/api/voice/route.ts";
import { MAX_SAMPLES, MIN_SAMPLES } from "@/lib/voice/distill.ts";
import {
  DISTILL_MAX_SAMPLES,
  DISTILL_MIN_SAMPLES,
  MIN_SAMPLE_LENGTH,
} from "@/types/voice-api.ts";
import { MAX_EXAMPLES, type VoiceExample } from "@/types/voice.ts";
import type { VoiceErrorBody, VoiceProfileBody } from "@/types/voice-api.ts";

/**
 * Route-level coverage for `/api/voice`.
 *
 * Only the paths that do not write run through the route: a successful PUT
 * would overwrite the profile of whoever is running the tests. The write paths
 * are covered against a temp root in `tests/voice-service.test.ts`, and the
 * rejections asserted here happen *before* any write, which is exactly the
 * property worth pinning — the example cap has to hold server-side, not just in
 * the UI that is meant to make it visible.
 */

const previousProvider = process.env.LLM_PROVIDER;

beforeAll(() => {
  process.env.LLM_PROVIDER = "mock";
});

afterAll(() => {
  if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = previousProvider;
});

function request(method: "PUT" | "POST", body: unknown, raw?: string): Request {
  return new Request("http://localhost/api/voice", {
    method,
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

function validTraits() {
  return {
    tone: "Blunt and warm at the same time.",
    sentence_rhythm: "Short declaratives, often fragments.",
    opener_patterns: ["Flat contradiction of a common belief"],
    recurring_phrases: ["here's the boring part"],
    banned_phrases: ["unlock the power of"],
    emoji_usage: "rare",
    vocabulary_register: "casual",
  };
}

function sample(index: number): VoiceExample {
  return {
    type: "caption",
    text: `Sample number ${index}: you do not need a program, you need to show up twice a week for three months.`,
    tags: ["caption"],
  };
}

describe("GET /api/voice", () => {
  it("answers with a profile envelope and the seeded AI tells", async () => {
    const response = GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as VoiceProfileBody;
    expect(body.ok).toBe(true);
    expect(typeof body.exists).toBe("boolean");
    // A missing profile is a first-run state, not an error: `exists: false`
    // with a null profile, never a 500.
    expect(body.source).toBe(body.exists ? "saved" : "none");
    if (body.exists) expect(body.profile).not.toBeNull();
    else expect(body.profile).toBeNull();
    expect(body.seedBannedPhrases).toContain("unlock the power of");
    expect(body.seedBannedPhrases).toContain("in today's fast-paced world");
    expect(body.seedBannedPhrases).toContain("dive into");
  });
});

describe("PUT /api/voice validation", () => {
  it("rejects a body that is not JSON", async () => {
    const response = await PUT(request("PUT", null, "{nope"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as VoiceErrorBody;
    expect(body.error.code).toBe("bad_request");
  });

  it("rejects a profile whose traits are missing", async () => {
    const response = await PUT(request("PUT", { examples: [] }));
    expect(response.status).toBe(400);

    const body = (await response.json()) as VoiceErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details?.join(" ")).toContain("traits");
  });

  it("rejects an empty tone rather than saving a profile that says nothing", async () => {
    const response = await PUT(
      request("PUT", { traits: { ...validTraits(), tone: "" }, examples: [] }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as VoiceErrorBody;
    expect(body.error.details?.join(" ")).toContain("tone");
  });

  it("rejects an emoji_usage outside the enum", async () => {
    const response = await PUT(
      request("PUT", {
        traits: { ...validTraits(), emoji_usage: "constant" },
        examples: [],
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a client-supplied updated_at instead of trusting it", async () => {
    const response = await PUT(
      request("PUT", {
        traits: validTraits(),
        examples: [],
        updated_at: "1999-01-01T00:00:00.000Z",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("enforces the example cap server-side, not only in the UI", async () => {
    const examples = Array.from({ length: MAX_EXAMPLES + 1 }, (_, index) => sample(index));
    const response = await PUT(request("PUT", { traits: validTraits(), examples }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as VoiceErrorBody;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.details?.join(" ")).toContain(String(MAX_EXAMPLES));
  });
});

describe("POST /api/voice distillation", () => {
  it("keeps its sample bounds in step with lib/voice/distill.ts", () => {
    expect(DISTILL_MIN_SAMPLES).toBe(MIN_SAMPLES);
    expect(DISTILL_MAX_SAMPLES).toBe(MAX_SAMPLES);
  });

  it("distils pasted samples into a draft profile without saving it", async () => {
    const samples = [sample(1), sample(2), sample(3)];
    const response = await POST(request("POST", { samples }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as VoiceProfileBody;
    expect(body.ok).toBe(true);
    // "draft" is the contract that nothing was written — the creator reviews
    // and saves, distillation never applies itself.
    expect(body.source).toBe("draft");
    expect(body.profile?.traits.tone.length).toBeGreaterThan(0);
    expect(body.profile?.examples).toHaveLength(3);
    expect(body.profile?.examples[0]?.text).toBe(samples[0]?.text);
    expect(body.meta?.provider).toBe("mock");
  });

  it("rejects fewer samples than the distiller can read anything from", async () => {
    const response = await POST(request("POST", { samples: [sample(1), sample(2)] }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as VoiceErrorBody;
    expect(body.error.message).toContain(String(DISTILL_MIN_SAMPLES));
  });

  it("rejects more samples than the window, rather than truncating silently", async () => {
    const samples = Array.from({ length: DISTILL_MAX_SAMPLES + 1 }, (_, i) => sample(i));
    const response = await POST(request("POST", { samples }));
    expect(response.status).toBe(400);
  });

  it("rejects a sample too short to be a writing sample", async () => {
    const response = await POST(
      request("POST", {
        samples: [sample(1), sample(2), { type: "caption", text: "nope", tags: [] }],
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as VoiceErrorBody;
    expect(body.error.details?.join(" ")).toContain(String(MIN_SAMPLE_LENGTH));
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(request("POST", null, "not json"));
    expect(response.status).toBe(400);
  });
});
