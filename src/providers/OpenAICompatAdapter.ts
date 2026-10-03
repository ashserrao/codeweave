import type { ProviderConfig, TokenUsage } from '../shared/types';
import { ProviderError, classifyHttpError } from './errors';
import { SseParser } from './sse';
import { parseRateLimitHeaders } from './rateLimits';
import type { CompletionRequest, CompletionResult, ProviderAdapter } from './types';
import { estimateTokens } from '../core/tokens';

/** Joins a base URL such as "https://api.openai.com/v1" with a path like "chat/completions". */
export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function buildHeaders(provider: ProviderConfig, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...provider.headers };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Wraps the caller's signal with an idle timeout that resets whenever data arrives.
 * Returns the combined signal plus `touch()` to reset the timer.
 */
function withIdleTimeout(signal: AbortSignal, idleMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleMs);
  };
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  touch();
  return {
    signal: controller.signal,
    touch,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

function toProviderError(err: unknown, userSignal: AbortSignal, timedOut: boolean): ProviderError {
  if (err instanceof ProviderError) return err;
  if (userSignal.aborted) return new ProviderError('cancelled', 'Request cancelled');
  if (timedOut) return new ProviderError('timeout', 'No response from provider within the idle timeout');
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
  return new ProviderError('network', `Could not reach provider: ${detail}`);
}

export class OpenAICompatAdapter implements ProviderAdapter {
  async stream(req: CompletionRequest, onText: (text: string) => void): Promise<CompletionResult> {
    const includeUsage = req.provider.supportsStreamUsage !== false;
    try {
      return await this.streamOnce(req, onText, includeUsage);
    } catch (err) {
      // Some OpenAI-compatible servers reject the stream_options field. Retry once without it.
      if (
        includeUsage &&
        err instanceof ProviderError &&
        err.kind === 'bad_request' &&
        /stream_options|include_usage/i.test(err.message)
      ) {
        const result = await this.streamOnce(req, onText, false);
        return { ...result, streamUsageUnsupported: true };
      }
      throw err;
    }
  }

  private async streamOnce(
    req: CompletionRequest,
    onText: (text: string) => void,
    includeUsage: boolean,
  ): Promise<CompletionResult> {
    const idle = withIdleTimeout(req.signal, req.idleTimeoutMs);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      max_tokens: req.maxTokens,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (includeUsage) body.stream_options = { include_usage: true };

    let text = '';
    let finishReason: string | undefined;
    let reported: TokenUsage | undefined;
    let rateLimits: CompletionResult['rateLimits'];

    try {
      const res = await fetch(endpoint(req.provider.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: buildHeaders(req.provider, req.apiKey),
        body: JSON.stringify(body),
        signal: idle.signal,
      });
      rateLimits = parseRateLimitHeaders(res.headers);
      if (!res.ok) {
        const err = classifyHttpError(res.status, await res.text().catch(() => ''), res.headers);
        err.rateLimits = rateLimits;
        throw err;
      }
      if (!res.body) throw new ProviderError('server', 'Provider returned an empty response body');

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        // Server ignored stream: true and returned a single JSON completion.
        const json: any = await res.json();
        text = json.choices?.[0]?.message?.content ?? '';
        finishReason = json.choices?.[0]?.finish_reason;
        if (text) onText(text);
        reported = parseUsage(json.usage);
      } else {
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        const handle = (data: string) => {
          if (data === '[DONE]') return;
          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            return; // tolerate keep-alive noise
          }
          if (json.error) {
            // Mid-stream error event (OpenRouter and others send these with HTTP 200).
            const status = Number(json.error.code ?? json.error.status);
            throw classifyHttpError(status >= 400 && status < 600 ? status : 500, data, new Headers());
          }
          const choice = json.choices?.[0];
          const delta: string | undefined = choice?.delta?.content ?? choice?.message?.content;
          if (delta) {
            text += delta;
            onText(delta);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const usage = parseUsage(json.usage);
          if (usage) reported = usage;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          idle.touch();
          for (const data of parser.push(decoder.decode(value, { stream: true }))) handle(data);
        }
        for (const data of parser.end()) handle(data);
      }
    } catch (err) {
      const providerError = toProviderError(err, req.signal, idle.timedOut());
      providerError.rateLimits ??= rateLimits;
      throw providerError;
    } finally {
      idle.dispose();
    }

    const usage: TokenUsage = reported ?? {
      promptTokens: estimateTokens(req.messages.map((m) => m.content).join('\n')),
      completionTokens: estimateTokens(text),
      source: 'estimated',
    };
    return { text, finishReason, usage, rateLimits };
  }

  async listModels(provider: ProviderConfig, apiKey: string | undefined, signal: AbortSignal): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(endpoint(provider.baseUrl, 'models'), {
        headers: buildHeaders(provider, apiKey),
        signal,
      });
    } catch (err) {
      throw toProviderError(err, signal, false);
    }
    if (!res.ok) throw classifyHttpError(res.status, await res.text().catch(() => ''), res.headers);
    const json: any = await res.json();
    const list: unknown[] = Array.isArray(json) ? json : json.data ?? json.models ?? [];
    return list
      .map((m) => (typeof m === 'string' ? m : (m as { id?: string; name?: string }).id ?? (m as { name?: string }).name))
      .filter((id): id is string => typeof id === 'string')
      .sort();
  }
}

function parseUsage(usage: any): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return undefined;
  return {
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0,
    source: 'reported',
  };
}
