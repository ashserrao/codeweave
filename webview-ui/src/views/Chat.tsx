import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatState } from '../../../src/shared/protocol';
import type { ChatMessage } from '../../../src/shared/types';
import { on, request, vscode } from '../rpc';
import { Markdown } from '../components/Markdown';
import { ChangesCard } from '../components/ChangesCard';
import logo from '../../../media/icon.png';

interface Persisted {
  draft?: string;
  includeEditor?: boolean;
}

const SUGGESTIONS = [
  { icon: 'lightbulb', text: 'Explain the selected code' },
  { icon: 'bug', text: 'Find bugs in the current file' },
  { icon: 'beaker', text: 'Write unit tests for the current file' },
  { icon: 'wand', text: 'Suggest refactorings to simplify this code' },
];

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const Icon = ({ name, spin, title }: { name: string; spin?: boolean; title?: string }) => (
  <i className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden={!title} title={title} />
);

export function Chat() {
  const persisted = vscode.getState<Persisted>() ?? {};
  const [state, setState] = useState<ChatState | undefined>();
  const [draft, setDraft] = useState(persisted.draft ?? '');
  const [includeEditor, setIncludeEditor] = useState(persisted.includeEditor ?? true);
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
      on('chat/editor', ({ editor }) => setState((s) => (s ? { ...s, editor } : s))),
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

  // Grow the input with its content, like Copilot Chat, up to a cap.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = async (text = draft) => {
    if (!text.trim() || state?.busy) return;
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

  /** Puts a question in the input (e.g. about a command's output) for the user to edit and send. */
  const askAbout = (text: string) => {
    setDraft(text);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  if (!state) {
    return (
      <div className="chat">
        <div className="welcome">{error ?? <Icon name="loading" spin />}</div>
      </div>
    );
  }

  const messages = state.conversation.messages;
  const target = state.target;
  const currentTarget =
    target.mode === 'pinned' ? state.targets.find((t) => t.providerId === target.providerId && t.modelId === target.modelId) : undefined;

  return (
    <div className="chat">
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && (
          <div className="welcome">
            <img className="welcome-logo" src={logo} alt="" />
            <h2>Ask CodeWeave</h2>
            <p className="muted">
              CodeWeave is powered by AI, so mistakes are possible. Review the output carefully before you use it.
            </p>
            {state.hasIntelligenceProvider ? (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s.text} className="suggestion" onClick={() => void send(s.text)}>
                    <Icon name={s.icon} /> {s.text}
                  </button>
                ))}
              </div>
            ) : (
              <div className="setup">
                <p>Connect an AI provider to start chatting. API keys are stored in VS Code SecretStorage.</p>
                <button className="btn primary" onClick={() => request('chat/openAdmin', undefined)}>
                  <Icon name="settings-gear" /> Open Settings &amp; Providers
                </button>
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={m.id}>
            <Turn message={m} streaming={state.busy && i === messages.length - 1} onAsk={askAbout} />
            {state.conversation.summary?.coversThroughId === m.id && (
              <div className="divider" title={state.conversation.summary.text}>
                <Icon name="fold-up" /> {state.conversation.summary.messageCount} earlier message(s) are sent as a summary by{' '}
                {state.conversation.summary.model} (local). Hover to read it.
              </div>
            )}
          </div>
        ))}
        {state.status && (
          <div className="status-line">
            <Icon name="loading" spin /> {state.status}
          </div>
        )}
      </div>

      {error && (
        <div className="banner error">
          <Icon name="error" /> {error}
        </div>
      )}

      <div className="input-area">
        <div className="input-box">
          {state.editor && (
            <div className="context-row">
              <button
                className={`context-chip ${includeEditor ? '' : 'off'}`}
                onClick={() => setIncludeEditor((v) => !v)}
                title={includeEditor ? 'Attached to your next message. Click to exclude.' : 'Not attached. Click to include.'}
              >
                <Icon name="file" />
                <span className="chip-name">
                  {state.editor.fileName}
                  {state.editor.selection && (
                    <span className="muted">
                      :{state.editor.selection.startLine}
                      {state.editor.selection.endLine !== state.editor.selection.startLine ? `-${state.editor.selection.endLine}` : ''}
                    </span>
                  )}
                </span>
                <span className="muted chip-kind">{state.editor.selection ? 'Current selection' : 'Current file'}</span>
                <Icon name={includeEditor ? 'eye' : 'eye-closed'} />
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            placeholder={state.hasIntelligenceProvider ? 'Ask CodeWeave' : 'Add a provider in Settings to start'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="input-toolbar">
            <button
              className="model-picker"
              title={currentTarget ? `${currentTarget.providerName} · ${currentTarget.model}` : 'Auto: provider priority with key rotation and fallback'}
              onClick={() => request('chat/pickModel', undefined)}
            >
              <span className="model-name">{currentTarget ? currentTarget.model : 'Auto'}</span>
              <Icon name="chevron-down" />
            </button>
            <span className="spacer" />
            {state.busy ? (
              <button className="send-btn" title="Stop (Esc)" onClick={() => request('chat/cancel', undefined)}>
                <Icon name="debug-stop" />
              </button>
            ) : (
              <button className="send-btn" title="Send (Enter)" disabled={!draft.trim()} onClick={() => void send()}>
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Turn({ message: m, streaming, onAsk }: { message: ChatMessage; streaming: boolean; onAsk: (text: string) => void }) {
  const isUser = m.role === 'user';
  return (
    <div className={`turn ${isUser ? 'turn-user' : 'turn-assistant'}`}>
      <div className="turn-header">
        {isUser ? (
          <span className="avatar avatar-user">
            <Icon name="account" />
          </span>
        ) : (
          <img className="avatar" src={logo} alt="" />
        )}
        <span className="turn-name">{isUser ? 'You' : 'CodeWeave'}</span>
        {!isUser && !streaming && m.content && (
          <span className="turn-actions">
            <button className="icon-btn" title="Copy response" onClick={() => request('chat/copy', { text: m.content })}>
              <Icon name="copy" />
            </button>
          </span>
        )}
      </div>
      {isUser ? <UserBody message={m} /> : <AssistantBody message={m} streaming={streaming} onAsk={onAsk} />}
    </div>
  );
}

function UserBody({ message: m }: { message: ChatMessage }) {
  return (
    <div className="turn-body">
      <div className="request">
        <div className="user-text">{m.content}</div>
        {!!m.attachments?.length && (
          <div className="refs">
            {m.attachments.map((a, i) => (
              <span key={i} className="ref" title={a.truncated ? `${a.path} (truncated to the configured limit)` : a.path}>
                <Icon name="file" /> {a.path.split(/[\\/]/).pop()}
                {a.startLine !== undefined ? `:${a.startLine}-${a.endLine}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantBody({ message: m, streaming, onAsk }: { message: ChatMessage; streaming: boolean; onAsk: (text: string) => void }) {
  const usage = m.meta?.usage;
  return (
    <div className="turn-body">
      {m.content ? (
        <Markdown
          text={m.content}
          onApply={streaming ? undefined : (code) => void request('changes/applyBlock', { messageId: m.id, code }).catch(() => undefined)}
        />
      ) : streaming ? (
        <div className="status-line">
          <Icon name="loading" spin /> Working…
        </div>
      ) : null}
      {m.meta?.error && (
        <div className="banner error pre">
          <Icon name="error" /> {m.meta.error}
        </div>
      )}
      {m.meta?.cancelled && (
        <div className="note">
          <Icon name="circle-slash" /> Stopped.
        </div>
      )}
      {m.meta?.route?.map((n, i) => (
        <div key={i} className="note">
          <Icon name="arrow-swap" /> {n}
        </div>
      ))}
      {m.meta?.contextNote && (
        <div className="note">
          <Icon name="fold" /> {m.meta.contextNote}
        </div>
      )}
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
      {!!m.changes?.length && <ChangesCard messageId={m.id} items={m.changes} onAsk={onAsk} />}
    </div>
  );
}
