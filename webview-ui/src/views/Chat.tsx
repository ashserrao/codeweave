import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '../../../src/shared/protocol';
import type { ChatMessage, ModelTarget } from '../../../src/shared/types';
import { on, request, vscode } from '../rpc';
import { Markdown } from '../components/Markdown';

interface Persisted {
  draft?: string;
  includeEditor?: boolean;
}

function targetValue(t: ModelTarget): string {
  return t.mode === 'auto' ? 'auto' : `${t.providerId}::${t.modelId}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function Chat() {
  const persisted = vscode.getState<Persisted>() ?? {};
  const [state, setState] = useState<ChatState | undefined>();
  const [draft, setDraft] = useState(persisted.draft ?? '');
  const [includeEditor, setIncludeEditor] = useState(persisted.includeEditor ?? true);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    vscode.setState<Persisted>({ draft, includeEditor });
  }, [draft, includeEditor]);

  useEffect(() => {
    const offs = [
      on('chat/state', setState),
      on('chat/status', ({ text }) => setState((s) => (s ? { ...s, status: text } : s))),
      on('chat/delta', ({ messageId, offset, text }) =>
        setState((s) => {
          if (!s) return s;
          const messages = s.conversation.messages.map((m) =>
            m.id === messageId && m.content.length >= offset ? { ...m, content: m.content.slice(0, offset) + text } : m,
          );
          return { ...s, conversation: { ...s.conversation, messages } };
        }),
      ),
      on('chat/message', (msg: ChatMessage) =>
        setState((s) => {
          if (!s) return s;
          const messages = s.conversation.messages.map((m) => (m.id === msg.id ? msg : m));
          return { ...s, conversation: { ...s.conversation, messages } };
        }),
      ),
      on('prefill', ({ text }) => {
        setDraft(text);
        setIncludeEditor(true);
        inputRef.current?.focus();
      }),
    ];
    request('chat/getState', undefined).then(setState, (e: Error) => setError(e.message));
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [state?.conversation]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = async () => {
    if (!draft.trim() || state?.busy) return;
    const text = draft;
    setDraft('');
    setError(undefined);
    stickToBottom.current = true;
    try {
      await request('chat/send', { text, includeEditor });
    } catch (e) {
      setDraft(text);
      setError((e as Error).message);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const changeTarget = (value: string) => {
    if (value === 'auto') void request('chat/setTarget', { mode: 'auto' });
    else {
      const [providerId, modelId] = value.split('::');
      void request('chat/setTarget', { mode: 'pinned', providerId, modelId });
    }
  };

  if (!state) return <div className="chat"><div className="empty">{error ?? 'Loading…'}</div></div>;

  const messages = state.conversation.messages;

  return (
    <div className="chat">
      <div className="toolbar">
        <select
          className="model-select"
          value={targetValue(state.target)}
          onChange={(e) => changeTarget(e.target.value)}
          title="Model routing. Auto follows provider priority with key rotation and fallback."
        >
          <option value="auto">Auto (priority + fallback)</option>
          {state.targets.map((t) => (
            <option key={`${t.providerId}::${t.modelId}`} value={`${t.providerId}::${t.modelId}`}>
              {t.providerName} · {t.model}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="Usage dashboard" onClick={() => request('chat/openUsage', undefined)}>
          📊
        </button>
        <button className="icon-btn" title="Chat history" onClick={() => setShowHistory((v) => !v)}>
          ☰
        </button>
        <button className="icon-btn" title="New chat" onClick={() => request('chat/new', undefined)}>
          ＋
        </button>
      </div>

      {showHistory && (
        <div className="history">
          {state.history.length === 0 && <div className="muted pad">No saved conversations yet.</div>}
          {state.history.map((h) => (
            <div key={h.id} className={`history-item ${h.id === state.conversation.id ? 'active' : ''}`}>
              <button
                className="history-open"
                onClick={() => {
                  void request('chat/open', { id: h.id });
                  setShowHistory(false);
                }}
              >
                <span className="history-title">{h.title}</span>
                <span className="muted small">
                  {new Date(h.updatedAt).toLocaleString()} · {h.messageCount} msgs
                </span>
              </button>
              <button className="icon-btn" title="Delete" onClick={() => request('chat/delete', { id: h.id })}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="messages" ref={listRef} onScroll={onScroll}>
        {!state.hasIntelligenceProvider && (
          <div className="card setup">
            <strong>Connect an AI provider</strong>
            <p>
              Add an intelligence provider (OpenAI, OpenRouter, Groq, or any OpenAI-compatible endpoint), a model and an
              API key. Keys are stored in VS Code SecretStorage.
            </p>
            <button className="btn primary" onClick={() => request('chat/openAdmin', undefined)}>
              Open Settings &amp; Providers
            </button>
          </div>
        )}
        {messages.length === 0 && state.hasIntelligenceProvider && (
          <div className="empty">
            <div className="brand">CodeWeave</div>
            <div className="muted">Your code. Connected intelligence.</div>
            <div className="muted small">The active editor's selection (or file excerpt) is attached when enabled below.</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id} className="msg-wrap">
            <MessageView message={m} streaming={state.busy && i === messages.length - 1} />
            {state.conversation.summary?.coversThroughId === m.id && (
              <div className="divider" title={state.conversation.summary.text}>
                ↑ {state.conversation.summary.messageCount} earlier message(s) are sent to the model as a summary by{' '}
                {state.conversation.summary.model} (local). Hover to read it.
              </div>
            )}
          </div>
        ))}
        {state.status && <div className="muted small typing">{state.status}</div>}
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="composer">
        <textarea
          ref={inputRef}
          value={draft}
          rows={3}
          placeholder="Ask about your code…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          <label className="check" title="Attach the current selection, or an excerpt of the active file">
            <input type="checkbox" checked={includeEditor} onChange={(e) => setIncludeEditor(e.target.checked)} />
            Include active editor
          </label>
          {state.busy ? (
            <button className="btn danger" onClick={() => request('chat/cancel', undefined)}>
              Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!draft.trim()} onClick={() => void send()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageView({ message: m, streaming }: { message: ChatMessage; streaming: boolean }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        {m.attachments?.map((a, i) => (
          <div key={i} className="chip" title={a.truncated ? 'Truncated to the configured limit' : undefined}>
            📎 {a.path}
            {a.startLine !== undefined ? `:${a.startLine}-${a.endLine}` : ''}
            {a.truncated ? ' (truncated)' : ''}
          </div>
        ))}
        <div className="user-text">{m.content}</div>
      </div>
    );
  }
  const usage = m.meta?.usage;
  return (
    <div className="msg assistant">
      {m.content ? <Markdown text={m.content} /> : streaming ? <div className="muted typing">Thinking…</div> : null}
      {m.meta?.error && <div className="banner error pre">{m.meta.error}</div>}
      {m.meta?.cancelled && <div className="muted small">Stopped.</div>}
      {m.meta?.route?.map((n, i) => (
        <div key={i} className="note">⇄ {n}</div>
      ))}
      {m.meta?.contextNote && <div className="note">✂ {m.meta.contextNote}</div>}
      {!streaming && m.meta?.model && (
        <div className="meta">
          {m.meta.providerName} · {m.meta.model}
          {m.meta.servedBy && <span title="Upstream provider chosen by the gateway"> · via {m.meta.servedBy}</span>}
          {usage && (
            <span title={usage.source === 'reported' ? 'Token counts reported by the provider' : 'Provider did not report usage; estimated locally (~4 chars/token)'}>
              {' '}
              · {formatTokens(usage.promptTokens)} in / {formatTokens(usage.completionTokens)} out
              {usage.source === 'estimated' ? ' (est.)' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
