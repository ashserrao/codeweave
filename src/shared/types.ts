// Types shared between the extension host and the webview UI.
// Must stay free of `vscode` and Node imports so the webview bundle can use it.

export type ProviderRole = 'intelligence' | 'context';
export type ProviderKind = 'openai-compatible';
export type KeyStatus = 'active' | 'cooldown' | 'exhausted' | 'invalid';
export type BudgetPeriod = 'day' | 'month' | 'total';

/** A token budget the user sets for a key. CodeWeave counts usage against it; it is not a provider quota. */
export interface KeyBudget {
  tokens: number;
  period: BudgetPeriod;
}

export interface ModelConfig {
  id: string;
  /** Model identifier sent to the API, e.g. "gpt-4o-mini" or "qwen2.5:3b". */
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  enabled: boolean;
}

/** Key metadata. The secret value itself lives only in SecretStorage. */
export interface KeyMeta {
  id: string;
  label: string;
  /** Masked hint such as "sk-…a1b2" so users can tell keys apart. */
  hint: string;
  enabled: boolean;
  status: KeyStatus;
  /** Epoch ms; set when the provider asked us to back off. */
  cooldownUntil?: number;
  lastError?: string;
  budget?: KeyBudget;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  role: ProviderRole;
  baseUrl: string;
  /** Lower number = tried first. */
  priority: number;
  enabled: boolean;
  /** Local servers (Ollama, LM Studio) usually need no key. */
  requiresKey: boolean;
  /** Extra non-secret headers, e.g. OpenRouter's HTTP-Referer. */
  headers: Record<string, string>;
  models: ModelConfig[];
  keys: KeyMeta[];
  /** Learned at runtime: whether the endpoint accepts stream_options.include_usage. */
  supportsStreamUsage?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** "reported" = from the provider response; "estimated" = computed locally. */
  source: 'reported' | 'estimated';
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface Attachment {
  kind: 'selection' | 'file';
  path: string;
  language: string;
  startLine?: number;
  endLine?: number;
  content: string;
  truncated: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  attachments?: Attachment[];
  meta?: {
    /** Key/provider switches that happened while producing this reply. */
    route?: string[];
    /** How the conversation was fitted into the model's context, when it had to be. */
    contextNote?: string;
    providerId?: string;
    providerName?: string;
    model?: string;
    keyId?: string;
    usage?: TokenUsage;
    error?: string;
    cancelled?: boolean;
  };
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** Rolling summary of older turns, produced by the local context model. */
export interface ContextSummary {
  text: string;
  /** Id of the last message folded into the summary. */
  coversThroughId: string;
  messageCount: number;
  providerName: string;
  model: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  summary?: ContextSummary;
}

/** "auto" follows provider priority; otherwise pin a specific provider + model. */
export type ModelTarget = { mode: 'auto' } | { mode: 'pinned'; providerId: string; modelId: string };

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  role: ProviderRole;
  exampleModel: string;
  headers?: Record<string, string>;
}

export interface TestResult {
  ok: boolean;
  message: string;
  models?: string[];
}

/** Rate-limit window state from response headers (x-ratelimit-*). Provider-reported. */
export interface RateLimitSnapshot {
  at: number;
  limitRequests?: number;
  remainingRequests?: number;
  resetRequestsAt?: number;
  limitTokens?: number;
  remainingTokens?: number;
  resetTokensAt?: number;
}

/** Account balance / credit limit from a provider's own API. Provider-reported. */
export interface BalanceSnapshot {
  at: number;
  /** Which API produced this, e.g. "OpenRouter /key". */
  source: string;
  currency?: string;
  /** null = provider reports no limit. */
  limit?: number | null;
  used?: number;
  /** null = unlimited. */
  remaining?: number | null;
  error?: string;
}

export interface TokenTotals {
  requests: number;
  failures: number;
  reportedPrompt: number;
  reportedCompletion: number;
  estimatedPrompt: number;
  estimatedCompletion: number;
}

export interface KeyUsageRow {
  /** Empty string for keyless (local) providers. */
  keyId: string;
  label: string;
  hint: string;
  enabled: boolean;
  status: KeyStatus | 'n/a';
  cooldownUntil?: number;
  lastError?: string;
  today: TokenTotals;
  month: TokenTotals;
  allTime: TokenTotals;
  budget?: { tokens: number; period: BudgetPeriod; used: number; remaining: number; includesEstimates: boolean };
  rateLimit?: RateLimitSnapshot;
  balance?: BalanceSnapshot;
}

export interface ProviderUsageRow {
  id: string;
  name: string;
  role: ProviderRole;
  enabled: boolean;
  baseUrl: string;
  balanceSupported: boolean;
  keys: KeyUsageRow[];
}

export interface UsageState {
  generatedAt: number;
  providers: ProviderUsageRow[];
  totals: {
    today: TokenTotals;
    month: TokenTotals;
    allTime: TokenTotals;
    keysTotal: number;
    keysUsable: number;
    budget: { keysWithBudget: number; keysWithoutBudget: number; remainingTokens: number; includesEstimates: boolean };
    rateLimit: { keysReporting: number; remainingTokens: number; remainingRequests: number };
    balances: { currency: string; remaining: number; keys: number; unlimitedKeys: number }[];
  };
}
