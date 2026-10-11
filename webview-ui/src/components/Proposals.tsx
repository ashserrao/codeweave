import { useState } from 'react';
import type { ChatMessage, CommandProposal, FileChangeProposal } from '../../../src/shared/types';
import { request } from '../rpc';

type OnError = (message: string) => void;

function call(promise: Promise<unknown>, onError: OnError): void {
  promise.catch((e: Error) => onError(e.message));
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  accepted: 'Applied',
  rejected: 'Rejected',
  failed: 'Failed',
  running: 'Running…',
  done: 'Ran',
};

function FileRow({ messageId, p, onError }: { messageId: string; p: FileChangeProposal; onError: OnError }) {
  const ids = { messageId, proposalId: p.id };
  const open = p.status === 'pending' || p.status === 'failed';
  const icon = p.op === 'delete' ? '🗑' : p.exists === false ? '＋' : '✎';
  const verb = p.op === 'delete' ? 'Delete' : p.exists === false ? 'Create' : 'Edit';
  const canOpen = p.op === 'delete' ? p.status !== 'accepted' : p.exists !== false || p.status === 'accepted';
  return (
    <div className={`proposal ${p.status}`}>
      <div className="proposal-head">
        <span className="proposal-icon" title={verb}>{icon}</span>
        <button className="link-btn proposal-path" title={`Open ${p.path}`} disabled={!canOpen}
          onClick={() => call(request('approval/openFile', { path: p.path }), onError)}>
          {p.path}
        </button>
        {p.added !== undefined && p.op !== 'delete' && (
          <span className="diffstat"><span className="add">+{p.added}</span> <span className="del">−{p.removed}</span></span>
        )}
        <span className={`pstatus ${p.status}`}>{STATUS_LABEL[p.status]}</span>
        <span className="spacer" />
        {open && (
          <>
            <button className="btn" disabled={p.status === 'failed'} title="Compare the current file with the proposal"
              onClick={() => call(request('approval/diff', ids), onError)}>Diff</button>
            <button className="btn primary" title={p.status === 'failed' ? 'Check the current file again and apply if it now matches' : 'Apply this change'}
              onClick={() => call(request('approval/accept', ids), onError)}>{p.status === 'failed' ? 'Retry' : 'Accept'}</button>
            <button className="btn" onClick={() => call(request('approval/reject', ids), onError)}>Reject</button>
          </>
        )}
      </div>
      {p.error && <div className="proposal-error">{p.error}</div>}
      {p.note && !p.error && <div className="muted small">ℹ {p.note}</div>}
    </div>
  );
}

function CommandRow({ messageId, p, onError }: { messageId: string; p: CommandProposal; onError: OnError }) {
  const [showOutput, setShowOutput] = useState(p.status === 'running');
  const ids = { messageId, proposalId: p.id };
  const ran = p.status === 'done' || p.status === 'failed';
  const exit = p.status === 'done' && p.exitCode !== undefined ? p.exitCode : undefined;
  return (
    <div className={`proposal ${p.status}`}>
      <div className="proposal-head">
        <span className="proposal-icon" title="Terminal command">▶</span>
        <code className="proposal-cmd" title={p.cwd ? `in ${p.cwd}` : 'in the workspace root'}>{p.command}</code>
        {p.cwd && <span className="muted small">in {p.cwd}</span>}
        <span className={`pstatus ${p.status} ${exit !== undefined ? (exit === 0 ? 'ok' : 'bad') : ''}`}>
          {exit !== undefined ? `Exit ${exit}` : STATUS_LABEL[p.status]}
        </span>
        <span className="spacer" />
        {p.status === 'pending' && (
          <>
            <button className="btn primary" title="Run in the CodeWeave terminal"
              onClick={() => { setShowOutput(true); call(request('approval/run', ids), onError); }}>Run</button>
            <button className="btn" onClick={() => call(request('approval/reject', ids), onError)}>Skip</button>
          </>
        )}
        {p.status === 'running' && (
          <button className="btn danger" title="Send Ctrl+C to the terminal" onClick={() => call(request('approval/stop', { proposalId: p.id }), onError)}>Stop</button>
        )}
        {ran && (
          <button className="btn" title="Run the command again" onClick={() => { setShowOutput(true); call(request('approval/run', ids), onError); }}>Run again</button>
        )}
        {(p.output || p.status === 'running') && (
          <button className="link-btn" onClick={() => setShowOutput((v) => !v)}>{showOutput ? 'Hide output' : 'Output'}</button>
        )}
      </div>
      {p.warning && p.status === 'pending' && <div className="proposal-warning">⚠ {p.warning} You will be asked to confirm.</div>}
      {p.error && <div className={p.status === 'failed' ? 'proposal-error' : 'muted small'}>{p.error}</div>}
      {showOutput && (p.output || p.status === 'running') && <pre className="proposal-output">{p.output || 'Waiting for output…'}</pre>}
    </div>
  );
}

/** Review card for the file changes and commands proposed in one assistant reply. */
export function Proposals({ message, onError }: { message: ChatMessage; onError: OnError }) {
  const proposals = message.proposals ?? [];
  if (!proposals.length) return null;
  const files = proposals.filter((p): p is FileChangeProposal => p.kind === 'file');
  const commands = proposals.filter((p): p is CommandProposal => p.kind === 'command');
  const pendingFiles = files.filter((p) => p.status === 'pending').length;
  const undecided = pendingFiles + files.filter((p) => p.status === 'failed').length + commands.filter((p) => p.status === 'pending').length;
  const summary = [
    files.length ? `${files.length} file change${files.length > 1 ? 's' : ''}` : '',
    commands.length ? `${commands.length} command${commands.length > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(', ');

  return (
    <div className="proposals card">
      <div className="proposals-head">
        <strong>Proposed: {summary}</strong>
        <span className="spacer" />
        {pendingFiles > 1 && (
          <button className="btn primary" title="Apply every pending file change in this reply (commands are never run in bulk)"
            onClick={() => call(request('approval/acceptAll', { messageId: message.id }), onError)}>Accept all</button>
        )}
        {undecided > 1 && (
          <button className="btn" title="Reject every pending change and skip every command that has not run"
            onClick={() => call(request('approval/rejectAll', { messageId: message.id }), onError)}>Reject all</button>
        )}
      </div>
      {files.map((p) => <FileRow key={p.id} messageId={message.id} p={p} onError={onError} />)}
      {commands.map((p) => <CommandRow key={p.id} messageId={message.id} p={p} onError={onError} />)}
    </div>
  );
}
