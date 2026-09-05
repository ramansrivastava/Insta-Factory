import { readFileSync } from "node:fs";
import path from "node:path";

import { LlmConfigError, LlmSchemaError } from "../errors.ts";
import type {
  LlmAdapter,
  LlmProvider,
  StructuredRequest,
  StructuredResult,
} from "../types.ts";

export const MOCK_MODEL = "mock-fixture-model";

/**
 * Fixtures live in `fixtures/llm/<kind>.json`, resolved from the repo root.
 * Kinds are restricted to a safe character set so a caller-supplied kind can
 * never escape the fixture directory.
 */
const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "llm");
const SAFE_KIND = /^[a-z0-9][a-z0-9._-]*$/i;

export interface MockAdapterOptions {
  /** Overrides fixture-file lookup entirely; used by unit tests. */
  fixtures?: Record<string, unknown>;
  fixtureDir?: string;
}

/**
 * Deterministic, zero-network adapter.
 *
 * This is load-bearing rather than a convenience: CI has no API key, so the
 * smoke test and the Layer-1 eval must both be able to run the full code path
 * offline and get byte-identical results every time.
 */
export class MockAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "mock";
  readonly model = MOCK_MODEL;

  private readonly fixtures?: Record<string, unknown>;
  private readonly fixtureDir: string;

  constructor(options: MockAdapterOptions = {}) {
    this.fixtures = options.fixtures;
    this.fixtureDir = options.fixtureDir ?? FIXTURE_DIR;
  }

  async generateStructured<T>(
    req: StructuredRequest<T>,
  ): Promise<StructuredResult<T>> {
    const raw = this.loadFixture(req.kind);

    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmSchemaError(
        `Mock fixture for "${req.kind}" does not match its schema: ${parsed.error.message}`,
        parsed.error,
      );
    }

    return {
      data: parsed.data,
      provider: this.provider,
      model: this.model,
      // Fixed, not measured: a deterministic adapter must not leak wall-clock
      // time or token counts into results the eval compares.
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      latencyMs: 0,
    };
  }

  private loadFixture(kind: string): unknown {
    if (this.fixtures) {
      if (!(kind in this.fixtures)) {
        throw new LlmConfigError(`No in-memory mock fixture registered for "${kind}".`);
      }
      return this.fixtures[kind];
    }

    if (!SAFE_KIND.test(kind)) {
      throw new LlmConfigError(
        `Invalid request kind "${kind}": expected letters, digits, dot, dash or underscore.`,
      );
    }

    const file = path.join(this.fixtureDir, `${kind}.json`);
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch (error) {
      throw new LlmConfigError(
        `Missing mock fixture for "${kind}" (expected ${file}).`,
        error,
      );
    }

    try {
      return JSON.parse(contents);
    } catch (error) {
      throw new LlmConfigError(`Mock fixture ${file} is not valid JSON.`, error);
    }
  }
}
