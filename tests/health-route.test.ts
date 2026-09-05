import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route.ts";

describe("GET /api/health", () => {
  it("reports ok plus the resolved provider and model", async () => {
    const body = await GET().json();

    expect(body.ok).toBe(true);
    expect(typeof body.provider).toBe("string");
    expect(body.provider.length).toBeGreaterThan(0);
    expect(typeof body.model).toBe("string");
    expect(body.model.length).toBeGreaterThan(0);
  });
});
