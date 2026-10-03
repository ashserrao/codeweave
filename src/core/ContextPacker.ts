import type { Attachment, ChatMessage, ContextSummary } from '../shared/types';
import type { WireMessage } from '../providers/types';
import { estimateTokens } from './tokens';

export function renderAttachment(a: Attachment): string {
  const range = a.startLine !== undefined ? ` (lines ${a.startLine}-${a.endLine})` : '';
  const label = a.kind === 'selection' ? 'Selected code' : 'Active file';
  const note = a.truncated ? '\n[content truncated]' : '';
  return `${label}: ${a.path}${range}\n\`\`\`${a.language}\n${a.content}\n\`\`\`${note}`;
}

export function renderMessage(m: ChatMessage): string {
  if (!m.attachments?.length) return m.content;
  return `${m.attachments.map(renderAttachment).join('\n\n')}\n\n${m.content}`;
}

export const CONTINUE_PROMPT =
  'Your previous response was cut off by a connection problem. Continue exactly where it stopped. ' +
  'Do not repeat any text that was already written and do not add a preamble.';

export interface PackOptions {
  contextWindow: number;
  maxOutputTokens: number;
  /** Safety margin for tokenizer differences between our estimate and the provider's. */
  marginRatio?: number;
}

export interface PackResult {
  messages: WireMessage[];
  droppedMessages: number;
  estimatedPromptTokens: number;
}

export function promptBudget(opts: PackOptions): number {
  return Math.floor((opts.contextWindow - opts.maxOutputTokens) * (1 - (opts.marginRatio ?? 0.1)));
}

/** Messages that still need to go to the model verbatim (i.e. not covered by the summary). */
export function unsummarized(history: ChatMessage[], summary: ContextSummary | undefined): ChatMessage[] {
  const usable = history.filter((m) => m.role !== 'system' && !(m.role === 'assistant' && !m.content));
  if (!summary) return usable;
  const i = usable.findIndex((m) => m.id === summary.coversThroughId);
  return i === -1 ? usable : usable.slice(i + 1);
}

export function systemWithSummary(system: string, summary: ContextSummary | undefined): string {
  if (!summary) return system;
  return `${system}\n\nSummary of the earlier part of this conversation (${summary.messageCount} messages, condensed by a local model):\n${summary.text}`;
}

/**
 * Fits the system prompt (+ summary of older turns) and the remaining conversation into the
 * model's context window. Keeps the newest turns; drops the oldest whole messages if still too
 * large. Older attachments are reduced to a one-line reference before whole messages are dropped.
 */
export function packContext(
  system: string,
  history: ChatMessage[],
  opts: PackOptions,
  summary?: ContextSummary,
): PackResult {
  const budget = promptBudget(opts);
  const usable = unsummarized(history, summary);
  const systemText = systemWithSummary(system, summary);

  let used = estimateTokens(systemText);
  const kept: WireMessage[] = [];
  let dropped = 0;

  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i];
    const isLatest = i === usable.length - 1;
    let content = renderMessage(m);
    let tokens = estimateTokens(content);
    if (!isLatest && used + tokens > budget && m.attachments?.length) {
      content = `${m.content}\n[earlier attachment omitted: ${m.attachments.map((a) => a.path).join(', ')}]`;
      tokens = estimateTokens(content);
    }
    if (used + tokens > budget) {
      if (isLatest) {
        // The newest message alone is too large: hard-truncate it rather than fail.
        const room = Math.max(256, (budget - used) * 4);
        content = `${content.slice(0, room)}\n[message truncated to fit the model's context window]`;
        tokens = estimateTokens(content);
      } else {
        dropped = i + 1;
        break;
      }
    }
    kept.unshift({ role: m.role as WireMessage['role'], content });
    used += tokens;
  }

  let systemContent = systemText;
  if (dropped > 0) {
    systemContent += `\n\nNote: ${dropped} earlier message(s) in this conversation were omitted to fit the context window.`;
  }
  return {
    messages: [{ role: 'system', content: systemContent }, ...kept],
    droppedMessages: dropped,
    estimatedPromptTokens: used,
  };
}

/**
 * How many of the oldest unsummarised messages to fold into the summary so the rest fits in
 * `targetRatio` of the prompt budget, leaving headroom for the next few turns (so we do not
 * summarise again on every message). Never folds the newest message. Returns 0 if it fits.
 */
export function selectFoldCount(
  system: string,
  messages: ChatMessage[],
  opts: PackOptions,
  summaryAllowanceTokens: number,
  targetRatio = 0.6,
): number {
  const budget = promptBudget(opts);
  const sizes = messages.map((m) => estimateTokens(renderMessage(m)));
  const total = estimateTokens(system) + sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return 0;

  const target = budget * targetRatio - estimateTokens(system) - summaryAllowanceTokens;
  let remaining = sizes.reduce((a, b) => a + b, 0);
  let fold = 0;
  while (fold < messages.length - 1 && remaining > target) {
    remaining -= sizes[fold];
    fold++;
  }
  return fold;
}

/** Plain-text transcript used as summariser input; large attachments are abbreviated. */
export function renderTranscript(messages: ChatMessage[], maxAttachmentChars = 1500): string {
  return messages
    .map((m) => {
      const who = m.role === 'user' ? 'User' : 'Assistant';
      const atts = (m.attachments ?? [])
        .map((a) => {
          const body = a.content.length > maxAttachmentChars ? `${a.content.slice(0, maxAttachmentChars)}\n[…]` : a.content;
          return `[${a.kind === 'selection' ? 'selection' : 'file'} ${a.path}]\n${body}`;
        })
        .join('\n');
      return `${who}:${atts ? `\n${atts}` : ''}\n${m.content}`;
    })
    .join('\n\n');
}

/** Splits text into chunks of at most `maxTokens` (estimated), preferring paragraph boundaries. */
export function chunkText(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(400, maxTokens * 4);
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
