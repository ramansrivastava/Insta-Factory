import { z } from "zod";

import type { StructuredRequest } from "./types.ts";

/**
 * A tiny structured request used to exercise the adapter path end-to-end
 * without any of the product's own prompts, which do not exist until Phase 3.
 *
 * The Layer-1 eval's `schema_validity` dimension and the adapter unit tests
 * both run this, so the LLM seam is covered from Phase 1 onward.
 */
export const PROBE_KIND = "probe";

export const ProbeSchema = z.object({
  ok: z.literal(true),
  provider_note: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
});

export type Probe = z.infer<typeof ProbeSchema>;

export function buildProbeRequest(): StructuredRequest<Probe> {
  return {
    kind: PROBE_KIND,
    system: [
      {
        // Stable across every probe call, so it is a valid cache prefix.
        text: "You are a health probe. Reply with the requested structured payload and nothing else.",
        cacheable: true,
      },
    ],
    messages: [
      {
        role: "user",
        content: "Return ok=true, a one-line provider note, and three short items.",
      },
    ],
    schema: ProbeSchema,
    schemaName: "probe",
    maxTokens: 1024,
    effort: "low",
  };
}
