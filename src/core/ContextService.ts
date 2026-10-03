import type { ChatMessage, ContextSummary } from '../shared/types';
import type { Router } from '../providers/Router';
import type { WireMessage } from '../providers/types';
import { CONTINUE_PROMPT, chunkText, renderTranscript } from './ContextPacker';
import { estimateTokens } from './tokens';

const SUMMARY_SYSTEM = [
  'You condense software-engineering conversations so another AI model can continue them.',
  'Write a compact summary in bullet points. Preserve exactly: the user\'s goals and requirements, decisions made and why,',
  'constraints, file paths, function/class/variable names, commands, error messages, versions, and open questions or next steps.',
  'Keep code only when it is essential (short signatures or key lines). Drop greetings, filler and repeated explanations.',
  'If an existing summary is given, merge the new excerpt into it and return one updated summary. Never invent facts.',
  'Stay under 400 words.',
].join(' ');

export interface SummaryResult {
  text: string;
  providerName: string;
  model: string;
}

/**
 * Uses the local *context* model (never a cloud intelligence provider) to fold older turns
 * into a rolling summary. Long inputs are summarised chunk by chunk, carrying the summary forward.
 */
export class ContextService {
  constructor(private readonly router: Router) {}

  isAvailable(): boolean {
    return this.router.candidates({ mode: 'auto' }, 'context').length > 0;
  }

  async summarize(
    previous: ContextSummary | undefined,
    messages: ChatMessage[],
    signal: AbortSignal,
    idleTimeoutMs: number,
  ): Promise<SummaryResult> {
    const first = this.router.candidates({ mode: 'auto' }, 'context')[0];
    if (!first) throw new Error('No local context model is configured or available');

    // Leave room for the instructions, the carried-forward summary and the model's output.
    const window = first.model.contextWindow - first.model.maxOutputTokens;
    const reserved = estimateTokens(SUMMARY_SYSTEM) + 700 + estimateTokens(previous?.text ?? '');
    const chunkBudget = Math.max(500, Math.floor(window * 0.8) - reserved);
    const chunks = chunkText(renderTranscript(messages), chunkBudget);

    let summary = previous?.text;
    let providerName = first.provider.name;
    let model = first.model.model;

    for (const chunk of chunks) {
      const user =
        (summary ? `Existing summary:\n${summary}\n\n` : '') +
        `New conversation excerpt:\n${chunk}\n\nReturn the ${summary ? 'updated ' : ''}summary only.`;
      const base: WireMessage[] = [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: user },
      ];
      const result = await this.router.complete({
        target: { mode: 'auto' },
        role: 'context',
        signal,
        idleTimeoutMs,
        buildMessages: (_c, partial) =>
          partial ? [...base, { role: 'assistant', content: partial }, { role: 'user', content: CONTINUE_PROMPT }] : base,
        onText: () => undefined,
      });
      const text = result.text.trim();
      if (!text) throw new Error('Local context model returned an empty summary');
      summary = text;
      providerName = result.candidate.provider.name;
      model = result.candidate.model.model;
    }

    return { text: summary ?? '', providerName, model };
  }
}
