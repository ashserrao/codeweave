import type { ChatMessage, Conversation, Proposal } from '../shared/types';
import { tail } from './commands';

const OUTPUT_IN_CONTEXT_CHARS = 2000;

function describe(p: Proposal): string | undefined {
  if (p.kind === 'file') {
    const what = p.op === 'delete' ? `delete ${p.path}` : p.path;
    switch (p.status) {
      case 'accepted': return `${what}: accepted and applied`;
      case 'rejected': return `${what}: rejected by the user`;
      case 'failed': return `${what}: could not be applied (${p.error ?? 'unknown error'})`;
      default: return `${what}: not reviewed yet`;
    }
  }
  const cmd = `command \`${p.command.split('\n')[0]}\``;
  switch (p.status) {
    case 'rejected': return `${cmd}: skipped by the user`;
    case 'pending': return `${cmd}: not run yet`;
    case 'running': return `${cmd}: still running`;
    case 'failed': return `${cmd}: could not run (${p.error ?? 'unknown error'})`;
    default: {
      const code = p.exitCode === undefined ? 'exit code unknown' : `exit code ${p.exitCode}`;
      if (!p.outputCaptured) return `${cmd}: ran in the terminal (${code}; output not captured)`;
      const out = p.output?.trim() ? `\n\`\`\`\n${tail(p.output.trim(), OUTPUT_IN_CONTEXT_CHARS)}\n\`\`\`` : ' with no output';
      return `${cmd}: ${code}${out}`;
    }
  }
}

const OUTCOME_HEADER = '[CodeWeave editor report: outcome of the proposals in your previous reply. Written by the editor, not by the user.]';

/** Tells the model what happened to the changes and commands it proposed in a reply. */
export function renderOutcome(proposals: Proposal[] | undefined): string {
  const lines = (proposals ?? []).map(describe).filter((l): l is string => !!l);
  return lines.length ? `${OUTCOME_HEADER}\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

/**
 * Copies of the messages where each user message starts with the outcome of the proposals in
 * the assistant reply before it. Putting the report in the user turn (not appended to the
 * model's own reply) keeps the model from imitating it in later replies.
 */
export function withOutcomes(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m, i) => {
    const prev = messages[i - 1];
    if (m.role !== 'user' || prev?.role !== 'assistant') return m;
    const outcome = renderOutcome(prev.proposals);
    return outcome ? { ...m, content: `${outcome}\n\n${m.content}` } : m;
  });
}

/** Removes an outcome report the model wrote into its own reply (it can only invent one). */
export function stripEchoedOutcome(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\[CodeWeave\b.*outcome.*\]\s*$/i.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Skip the report's bullet list, including any fenced command output inside it.
    let fenced = false;
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (/^\s*```/.test(next)) fenced = !fenced;
      else if (!fenced && !/^(- |\s{2,}\S)/.test(next)) break;
      i++;
    }
  }
  return out.join('\n').trimEnd();
}

/** Commands cannot still be running after a reload; mark them so the UI does not wait forever. */
export function markInterrupted(conv: Conversation): Conversation {
  for (const m of conv.messages) {
    for (const p of m.proposals ?? []) {
      if (p.kind === 'command' && p.status === 'running') {
        p.status = 'done';
        p.error = 'CodeWeave was reloaded while this command was running; its result is unknown.';
      }
    }
  }
  return conv;
}
