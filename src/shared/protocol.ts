// Typed RPC between the webview and the extension host.
// Webview -> host: requests { kind: 'req', id, method, params } answered by { kind: 'res', id, result | error }.
// Host -> webview: events { kind: 'event', name, payload }.

import type {
  ChatMessage,
  KeyBudget,
  UsageState,
  Conversation,
  ConversationSummary,
  EditorInfo,
  ModelTarget,
  ProviderConfig,
  ProviderPreset,
  TestResult,
} from './types';

export interface ChatState {
  conversation: Conversation;
  history: ConversationSummary[];
  busy: boolean;
  /** Transient progress text, e.g. "Summarising earlier messages…". */
  status?: string;
  target: ModelTarget;
  targets: { providerId: string; providerName: string; modelId: string; model: string }[];
  hasIntelligenceProvider: boolean;
  hasContextModel: boolean;
  editor?: EditorInfo;
}

export interface AdminState {
  providers: ProviderConfig[];
  presets: ProviderPreset[];
}

export interface Methods {
  'chat/getState': { params: void; result: ChatState };
  'chat/send': { params: { text: string; includeEditor: boolean }; result: void };
  'chat/cancel': { params: void; result: void };
  'chat/new': { params: void; result: void };
  'chat/open': { params: { id: string }; result: void };
  'chat/delete': { params: { id: string }; result: void };
  'chat/setTarget': { params: ModelTarget; result: void };
  'chat/openAdmin': { params: void; result: void };
  'chat/copy': { params: { text: string }; result: void };
  'chat/openUsage': { params: void; result: void };
  /** Opens a searchable Quick Pick of models (Auto + every enabled intelligence model). */
  'chat/pickModel': { params: void; result: void };
  /** A click on a change card. Only accept/undo/stop can lead to a write or command, and only for these ids. */
  'changes/act': {
    params: { messageId: string; itemIds: string[]; action: 'accept' | 'reject' | 'undo' | 'stop' | 'diff' | 'open' };
    result: void;
  };
  /** "Apply to editor" on a plain code block: creates a pending change for the active file. */
  'changes/applyBlock': { params: { messageId: string; code: string }; result: void };

  'admin/getState': { params: void; result: AdminState };
  'admin/saveProvider': { params: ProviderConfig; result: void };
  'admin/deleteProvider': { params: { id: string }; result: void };
  'admin/move': { params: { id: string; direction: -1 | 1 }; result: void };
  'admin/addKey': { params: { providerId: string; label: string; secret: string }; result: void };
  'admin/deleteKey': { params: { providerId: string; keyId: string }; result: void };
  'admin/resetKey': { params: { providerId: string; keyId: string }; result: void };
  'admin/test': { params: { providerId: string }; result: TestResult };
  'admin/setBudget': { params: { providerId: string; keyId: string; budget: KeyBudget | null }; result: void };
  'admin/openUsage': { params: void; result: void };

  'usage/getState': { params: void; result: UsageState };
  /** Calls provider balance APIs (only where one exists). Runs only on explicit user action. */
  'usage/refreshBalances': { params: void; result: { checked: number; unsupported: number } };
  'usage/clear': { params: void; result: void };
  'usage/openAdmin': { params: void; result: void };
}

export type MethodName = keyof Methods;

export interface Events {
  'chat/state': ChatState;
  /** Streaming text for the in-flight assistant message. */
  'chat/delta': { messageId: string; offset: number; text: string };
  'chat/message': ChatMessage;
  'admin/state': AdminState;
  'chat/status': { text?: string };
  'chat/editor': { editor?: EditorInfo };
  'usage/state': UsageState;
  'prefill': { text: string };
}

export type EventName = keyof Events;

export type WebviewToHost = {
  kind: 'req';
  id: number;
  method: MethodName;
  params: unknown;
};

export type HostToWebview =
  | { kind: 'res'; id: number; result?: unknown; error?: string }
  | { kind: 'event'; name: EventName; payload: unknown };
