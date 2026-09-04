import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  LlmConfigError,
  LlmRateLimitError,
  LlmRefusalError,
  LlmSchemaError,
  LlmTruncatedError,
  LlmUpstreamError,
} from "../errors.ts";
import type {
  LlmAdapter,
  LlmProvider,
  StructuredRequest,
  StructuredResult,
  SystemBlock,
} from "../types.ts";

export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * The Messages API accepts at most four `cache_control` breakpoints per
 * request. When more blocks are flagged we keep the *last* four, which yields
 * the longest cached prefix.
 */
const MAX_CACHE_BREAKPOINTS = 4;

export interface AnthropicAdapterOptions {
  apiKey: string;
  model?: string;
  client?: Anthropic;
}

/**
 * Builds the `system` parameter, placing a prompt-cache breakpoint on each
 * block the caller flagged as cacheable (capped at the API's four).
 */
export function buildSystemBlocks(
  blocks: readonly SystemBlock[],
): Anthropic.TextBlockParam[] {
  const cacheableIndexes = blocks
    .map((block, index) => (block.cacheable ? index : -1))
    .filter((index) => index >= 0)
    .slice(-MAX_CACHE_BREAKPOINTS);
  const breakpoints = new Set(cacheableIndexes);

  return blocks.map((block, index) => {
    const param: Anthropic.TextBlockParam = { type: "text", text: block.text };
    if (breakpoints.has(index)) {
      param.cache_control = { type: "ephemeral" };
    }
    return param;
  });
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider: LlmProvider = "anthropic";
  readonly model: string;

  private readonly client: Anthropic;

  constructor(options: AnthropicAdapterOptions) {
    if (!options.client && !options.apiKey) {
      throw new LlmConfigError(
        "AnthropicAdapter requires an API key. Set ANTHROPIC_API_KEY or use LLM_PROVIDER=mock.",
      );
    }
    this.model = options.model || DEFAULT_MODEL;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  }

  async generateStructured<T>(
    req: StructuredRequest<T>,
  ): Promise<StructuredResult<T>> {
    const startedAt = Date.now();

    // Deliberately absent: temperature / top_p / top_k. They are removed on
    // Claude Sonnet 5 and Opus 5 and return a 400. `req.samplingHints` is
    // accepted by the interface for other providers and ignored here.
    // Also deliberately absent: `thinking` — adaptive is the default on these
    // models, and assistant prefill (another 400) is never used; the output
    // shape is constrained with `output_config.format` instead.
    let response;
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens,
        system: buildSystemBlocks(req.system),
        messages: req.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        output_config: {
          effort: req.effort ?? "high",
          format: zodOutputFormat(req.schema),
        },
      });
    } catch (error: unknown) {
      throw toLlmError(error, req.kind);
    }

    // Guard the refusal stop reason before touching content: a refusal is an
    // HTTP 200 whose content must not be read as an answer.
    if (response.stop_reason === "refusal") {
      const details = response.stop_details;
      throw new LlmRefusalError(
        `Model refused the "${req.kind}" request.`,
        details?.category ?? null,
        details?.explanation ?? null,
      );
    }

    if (response.stop_reason === "max_tokens") {
      throw new LlmTruncatedError(
        `Response for "${req.kind}" hit max_tokens (${req.maxTokens}); the structured payload is truncated.`,
      );
    }

    const parsed = req.schema.safeParse(response.parsed_output);
    if (!parsed.success) {
      throw new LlmSchemaError(
        `Response for "${req.kind}" did not match its schema: ${parsed.error.message}`,
        parsed.error,
      );
    }

    return {
      data: parsed.data,
      provider: this.provider,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Most-specific-first error chain. A single broad catch would lose the
 * distinction between retryable (429, 5xx, connection) and non-retryable
 * (400, 404) failures.
 */
export function toLlmError(error: unknown, kind: string): Error {
  if (error instanceof Anthropic.NotFoundError) {
    return new LlmUpstreamError(
      `Model or endpoint not found while running "${kind}": ${error.message}`,
      error.status,
      error,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    const header = error.headers?.get("retry-after");
    const retryAfter = header === null || header === undefined ? null : Number(header);
    return new LlmRateLimitError(
      `Rate limited while running "${kind}": ${error.message}`,
      Number.isFinite(retryAfter) ? (retryAfter as number) : null,
      error,
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmUpstreamError(
      `Could not reach the Anthropic API while running "${kind}": ${error.message}`,
      null,
      error,
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmUpstreamError(
      `Anthropic API error while running "${kind}": ${error.message}`,
      error.status ?? null,
      error,
    );
  }
  return error instanceof Error
    ? error
    : new LlmUpstreamError(`Unknown failure while running "${kind}".`, null, error);
}
