import { useState } from 'react';
import type { ChangeItem } from '../../../src/shared/types';
import { request } from '../rpc';

type Action = 'accept' | 'reject' | 'undo' | 'stop' | 'diff' | 'open';

const Icon = ({ name, spin }: { name: string; spin?: boolean }) => (
  <i className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden />
);

const KIND_ICON: Record<ChangeItem['kind'], string> = { edit: 'edit', create: 'new-file', delete: 'trash', command: 'terminal' };

function statusLabel(c: ChangeItem): { icon: string; text: string; cls: string; spin?: boolean } | undefined {
  const isCmd = c.kind === 'command';
  switch (c.status) {
    case 'running':
      return { icon: 'loading', text: 'Running', cls: 'running', spin: true };
    case 'applied':
      return { icon: 'check', text: isCmd ? (c.output?.captured ? `Exit ${c.output.exitCode ?? 0}` : 'Sent') : 'Applied', cls: 'ok' };
    case 'rejected':
      return { icon: 'close', text: isCmd ? 'Skipped' : 'Rejected', cls: 'muted' };
    case 'undone':
      return { icon: 'discard', text: 'Undone', cls: 'muted' };
    case 'failed':
      return { icon: 'error', text: isCmd && c.output ? `Exit ${c.output.exitCode}` : 'Not applied', cls: 'bad' };
    default:
      return undefined;
  }
}

/**
 * Copilot-style review card for the changes proposed in one reply. Every button maps to one
 * explicit RPC; nothing here applies changes on its own.
 */
export function ChangesCard({ messageId, items, onAsk }: { messageId: string; items: ChangeItem[]; onAsk: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (action: Action, ids: string[]) => {
    setBusy(true);
    try {
      await request('changes/act', { messageId, itemIds: ids, action });
    } finally {
      setBusy(false);
    }
  };

  const pendingFiles = items.filter((c) => c.status === 'pending' && c.kind !== 'command');
  const pendingAll = items.filter((c) => c.status === 'pending');
  const files = items.filter((c) => c.kind !== 'command').length;
  const commands = items.length - files;
  const added = items.reduce((n, c) => n + (c.added ?? 0), 0);
  const removed = items.reduce((n, c) => n + (c.removed ?? 0), 0);

  return (
    <div className="changes-card">
      <div className="changes-head">
        <Icon name="diff-multiple" />
        <span className="changes-title">
          {files > 0 && `${files} file${files === 1 ? '' : 's'} changed`}
          {files > 0 && commands > 0 && ' · '}
          {commands > 0 && `${commands} command${commands === 1 ? '' : 's'}`}
        </span>
        {files > 0 && (
          <span className="stat">
            <span className="add">+{added}</span> <span className="del">−{removed}</span>
          </span>
        )}
        <span className="spacer" />
        {pendingFiles.length > 1 && (
          <button className="btn primary small" disabled={busy} onClick={() => act('accept', pendingFiles.map((c) => c.id))} title="Apply every pending file change in this card (commands run one at a time)">
            <Icon name="check-all" /> Accept all
          </button>
        )}
        {pendingAll.length > 1 && (
          <button className="btn small" disabled={busy} onClick={() => act('reject', pendingAll.map((c) => c.id))}>
            Reject all
          </button>
        )}
      </div>

      {items.map((c) => (
        <ChangeRow key={c.id} c={c} busy={busy} act={act} onAsk={onAsk} />
      ))}

      {pendingAll.length > 0 && (
        <div className="changes-foot muted small">
          <Icon name="shield" /> Nothing is changed until you accept. Click a file name to review its diff.
        </div>
      )}
    </div>
  );
}

function ChangeRow({
  c,
  busy,
  act,
  onAsk,
}: {
  c: ChangeItem;
  busy: boolean;
  act: (a: Action, ids: string[]) => Promise<void>;
  onAsk: (text: string) => void;
}) {
  const st = statusLabel(c);
  const isCmd = c.kind === 'command';
  const viewable = !isCmd && c.status !== 'failed' && !!c.path;
  const name = c.path?.split('/').pop() ?? c.path;
  const dir = c.path && c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '';

  return (
    <div className={`change-row status-${c.status}`}>
      <div className="change-main">
        <Icon name={KIND_ICON[c.kind]} />
        {isCmd ? (
          <code className="change-command" title={`Runs in ${c.cwd ?? '.'}`}>{c.command}</code>
        ) : (
          <button className="change-path" disabled={!viewable} onClick={() => act('diff', [c.id])} title={viewable ? 'Review the diff' : c.path}>
            <span className="change-name">{name}</span>
            {dir && <span className="change-dir">{dir}</span>}
            {c.kind === 'create' && <span className="tag">new</span>}
            {c.kind === 'delete' && <span className="tag">delete</span>}
          </button>
        )}
        {!isCmd && c.status !== 'failed' && (
          <span className="stat">
            {!!c.added && <span className="add">+{c.added}</span>} {!!c.removed && <span className="del">−{c.removed}</span>}
          </span>
        )}
        <span className="spacer" />
        {st && (
          <span className={`change-status ${st.cls}`}>
            <Icon name={st.icon} spin={st.spin} /> {st.text}
          </span>
        )}
        <span className="change-actions">
          {c.status === 'pending' && !isCmd && (
            <>
              <button className="icon-btn" disabled={busy} title="Review diff" onClick={() => act('diff', [c.id])}>
                <Icon name="diff" />
              </button>
              <button className="icon-btn accept" disabled={busy} title="Accept" onClick={() => act('accept', [c.id])}>
                <Icon name="check" />
              </button>
              <button className="icon-btn reject" disabled={busy} title="Reject" onClick={() => act('reject', [c.id])}>
                <Icon name="close" />
              </button>
            </>
          )}
          {c.status === 'pending' && isCmd && (
            <>
              <button className="btn primary small" disabled={busy} title={`Run in ${c.cwd ?? '.'}`} onClick={() => act('accept', [c.id])}>
                <Icon name="play" /> Run
              </button>
              <button className="btn small" disabled={busy} onClick={() => act('reject', [c.id])}>
                Skip
              </button>
            </>
          )}
          {c.status === 'running' && (
            <button className="btn small" onClick={() => act('stop', [c.id])}>
              <Icon name="debug-stop" /> Stop
            </button>
          )}
          {c.status === 'applied' && !isCmd && (
            <>
              <button className="icon-btn" title="Open file" onClick={() => act('open', [c.id])}>
                <Icon name="go-to-file" />
              </button>
              <button className="icon-btn" title="Show what changed" onClick={() => act('diff', [c.id])}>
                <Icon name="diff" />
              </button>
              <button className="icon-btn" title="Undo this change" onClick={() => act('undo', [c.id])}>
                <Icon name="discard" />
              </button>
            </>
          )}
        </span>
      </div>
      {c.error && (
        <div className="change-msg bad">
          <Icon name="error" /> {c.error}
        </div>
      )}
      {c.note && (
        <div className="change-msg">
          <Icon name="info" /> {c.note}
        </div>
      )}
      {isCmd && c.output?.captured && (
        <details className="change-output">
          <summary>
            Output{c.output.truncated ? ' (last 20,000 characters)' : ''}
            <button
              className="link-btn"
              onClick={(e) => {
                e.preventDefault();
                onAsk(`The command \`${c.command}\` exited with code ${c.output?.exitCode}. Output:\n\n\`\`\`\n${c.output?.text.slice(-6000)}\n\`\`\`\n\nWhat went wrong and how do I fix it?`);
              }}
            >
              Ask about this output
            </button>
          </summary>
          <pre>{c.output.text || '(no output)'}</pre>
        </details>
      )}
    </div>
  );
}
