import type { ZodType } from "zod";

/** Providers this project knows how to construct an adapter for. */
export type LlmProvider = "anthropic" | "mock";

/**
 * Cost/quality dial. On current Claude models this replaces `temperature` —
 * see `samplingHints` below for why.
 */
export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One block of the system prompt.
 *
 * `cacheable` marks a block as part of the stable prefix that is worth a
 * prompt-cache breakpoint. Prompt caching is a *prefix* match, so every
 * cacheable block must come before every non-cacheable one, and nothing
 * per-request (timestamps, ids, unsorted JSON) may leak into a cacheable block —
 * it invalidates the cache silently, with no error.
 */
export interface SystemBlock {
  text: string;
  cacheable?: boolean;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Optional sampling preferences.
 *
 * `temperature` / `top_p` / `top_k` are REMOVED on Claude Sonnet 5 and Opus 5
 * and return a 400. The Anthropic adapter therefore accepts these hints and
 * deliberately ignores them; an adapter for a provider that still supports
 * sampling may honour them. Never send them to Anthropic.
 */
export interface SamplingHints {
  temperature?: number;
  topP?: number;
  topK?: number;
}

export interface StructuredRequest<T> {
  /**
   * Stable identifier for *what kind* of call this is (e.g. `"hooks"`,
   * `"script"`). The mock adapter keys its fixtures off this; the Anthropic
   * adapter uses it only for error messages.
   */
  kind: string;
  system: SystemBlock[];
  messages: LlmMessage[];
  /** Single source of truth for the output shape. */
  schema: ZodType<T>;
  /** Name handed to the provider's structured-output format. */
  schemaName?: string;
  maxTokens: number;
  effort?: LlmEffort;
  samplingHints?: SamplingHints;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Zero across repeated requests with an identical prefix means prompt caching
   * has silently broken. Logged from Phase 6 onward precisely so it is visible.
   */
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface StructuredResult<T> {
  data: T;
  provider: LlmProvider;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
}

/**
 * The project-owned provider contract. Swapping providers means implementing
 * this interface — no caller changes.
 */
export interface LlmAdapter {
  readonly provider: LlmProvider;
  readonly model: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
