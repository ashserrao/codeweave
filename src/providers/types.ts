import type { ProviderConfig, RateLimitSnapshot, TokenUsage } from '../shared/types';

export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  provider: ProviderConfig;
  model: string;
  apiKey?: string;
  messages: WireMessage[];
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
  idleTimeoutMs: number;
}

export interface CompletionResult {
  text: string;
  finishReason?: string;
  usage: TokenUsage;
  /** Set when the adapter learned the endpoint rejects stream_options. */
  streamUsageUnsupported?: boolean;
  rateLimits?: RateLimitSnapshot;
}

/**
 * One implementation per API style. New styles (Anthropic Messages, Gemini, …)
 * plug in here without changes to routing, chat or UI code.
 */
export interface ProviderAdapter {
  stream(req: CompletionRequest, onText: (text: string) => void): Promise<CompletionResult>;
  listModels(provider: ProviderConfig, apiKey: string | undefined, signal: AbortSignal): Promise<string[]>;
}
