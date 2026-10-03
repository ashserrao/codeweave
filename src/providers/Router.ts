import type { ModelTarget, ProviderConfig, TokenUsage } from '../shared/types';
import { ProviderError, describeError } from './errors';
import { buildCandidates, explainNoCandidates, type Candidate } from './candidates';
import type { ProviderRegistry } from './ProviderRegistry';
import type { CompletionResult, ProviderAdapter, WireMessage } from './types';
import { exhaustedUntil } from './rateLimits';
import type { UsageLedger } from '../usage/UsageLedger';
import { keysOverBudget } from '../usage/usageReport';
import { estimateTokens } from '../core/tokens';

const DEFAULT_COOLDOWN_MS = 60_000;

export interface RouteAttempt {
  providerName: string;
  model: string;
  keyLabel?: string;
  error: string;
}

export interface RoutedResult extends CompletionResult {
  /** The candidate that produced the final part of the answer. */
  candidate: Candidate;
  attempts: RouteAttempt[];
  /** Human-readable notes about key rotation / provider fallback during this request. */
  notes: string[];
  /** True when the answer was continued on another provider after a mid-stream failure. */
  continued: boolean;
}

export interface RouteRequest {
  target: ModelTarget;
  role: ProviderConfig['role'];
  /**
   * Builds wire messages for a candidate. `partial` is the answer text produced so far by
   * earlier attempts (empty on the first attempt); when non-empty the builder must ask the
   * model to continue from it. Called per attempt because context windows differ per model.
   */
  buildMessages: (candidate: Candidate, partial: string) => WireMessage[];
  signal: AbortSignal;
  idleTimeoutMs: number;
  onText: (text: string) => void;
  onSwitch?: (note: string) => void;
}

type RouterRegistry = Pick<ProviderRegistry, 'list' | 'vault' | 'updateKey' | 'setStreamUsageSupport'>;
interface RouterLog {
  warn(message: string): void;
  info(message: string): void;
}

const describeCandidate = (c: Candidate) => `${c.provider.name}/${c.model.model}${c.key ? ` [${c.key.label}]` : ''}`;

function sumUsage(parts: TokenUsage[]): TokenUsage {
  return {
    promptTokens: parts.reduce((n, u) => n + u.promptTokens, 0),
    completionTokens: parts.reduce((n, u) => n + u.completionTokens, 0),
    source: parts.every((u) => u.source === 'reported') ? 'reported' : 'estimated',
  };
}

/**
 * Tries candidates in priority order:
 *  - rate limit -> key cools down for the provider's reset time, next key
 *  - quota / billing -> key marked exhausted, next key
 *  - auth -> key marked invalid, next key
 *  - server / network / timeout -> next provider
 * If text had already streamed, the next candidate continues the answer from that partial text
 * (context transfer) instead of starting over. Every attempt is recorded in the usage ledger.
 */
export class Router {
  constructor(
    private readonly registry: RouterRegistry,
    private readonly adapter: ProviderAdapter,
    private readonly ledger: UsageLedger,
    private readonly log: RouterLog,
  ) {}

  /** Ordered candidates for a target, excluding keys that are over budget. */
  candidates(target: ModelTarget, role: ProviderConfig['role']): Candidate[] {
    const providers = this.registry.list();
    return buildCandidates(providers, target, role, Date.now(), keysOverBudget(providers, this.ledger));
  }

  async complete(req: RouteRequest): Promise<RoutedResult> {
    const candidates = this.candidates(req.target, req.role);
    if (candidates.length === 0) {
      throw new ProviderError('bad_request', explainNoCandidates(this.registry.list(), req.role, Date.now()));
    }

    const attempts: RouteAttempt[] = [];
    const notes: string[] = [];
    const usageParts: TokenUsage[] = [];
    const skippedProviders = new Set<string>();
    const deadKeys = new Set<string>();
    let combined = '';
    let continued = false;
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const { provider, key } = candidate;
      if (skippedProviders.has(provider.id)) continue;
      if (key && deadKeys.has(key.id)) continue;
      if (req.signal.aborted) throw this.withPartial(new ProviderError('cancelled', 'Request cancelled'), combined);

      if (combined) continued = true;
      let streamedNow = '';
      let messages: WireMessage[] = [];
      try {
        const apiKey = key ? await this.registry.vault.get(provider.id, key.id) : undefined;
        if (key && !apiKey) throw new ProviderError('auth', 'Key value missing from SecretStorage; re-add the key');
        messages = req.buildMessages(candidate, combined);
        const result = await this.adapter.stream(
          {
            provider,
            model: candidate.model.model,
            apiKey,
            messages,
            maxTokens: candidate.model.maxOutputTokens,
            signal: req.signal,
            idleTimeoutMs: req.idleTimeoutMs,
          },
          (text) => {
            streamedNow += text;
            combined += text;
            req.onText(text);
          },
        );

        usageParts.push(result.usage);
        await this.ledger.record(provider.id, key?.id, result.usage, true);
        if (result.rateLimits) await this.ledger.setRateLimit(provider.id, key?.id, result.rateLimits);
        if (result.streamUsageUnsupported) await this.registry.setStreamUsageSupport(provider.id, false);

        // The provider says this key's window is now empty: rest it before the next request fails.
        const restUntil = exhaustedUntil(result.rateLimits, Date.now());
        if (key && restUntil) {
          await this.registry.updateKey(provider.id, key.id, {
            status: 'cooldown',
            cooldownUntil: restUntil,
            lastError: 'Provider reported the rate-limit window is used up',
          });
        } else if (key && key.status !== 'active') {
          await this.registry.updateKey(provider.id, key.id, { status: 'active', cooldownUntil: undefined, lastError: undefined });
        }

        return {
          ...result,
          text: combined,
          usage: sumUsage(usageParts),
          candidate,
          attempts,
          notes,
          continued,
        };
      } catch (err) {
        lastError = err;
        // Tokens already streamed were very likely billed; record an estimate for them.
        const partialUsage: TokenUsage | undefined = streamedNow
          ? { promptTokens: estimateTokens(messages.map((m) => m.content).join('\n')), completionTokens: estimateTokens(streamedNow), source: 'estimated' }
          : undefined;
        if (partialUsage) usageParts.push(partialUsage);
        await this.ledger.record(provider.id, key?.id, partialUsage, false);
        if (err instanceof ProviderError && err.rateLimits) await this.ledger.setRateLimit(provider.id, key?.id, err.rateLimits);

        if (err instanceof ProviderError && err.kind === 'cancelled') throw this.withPartial(err, combined);

        const attempt: RouteAttempt = {
          providerName: provider.name,
          model: candidate.model.model,
          keyLabel: key?.label,
          error: describeError(err),
        };
        attempts.push(attempt);
        this.log.warn(`Attempt failed: ${describeCandidate(candidate)}: ${attempt.error}`);

        await this.applyFailure(candidate, err, deadKeys, skippedProviders);
        if (!isRetryable(err)) throw this.withPartial(err, combined);

        const next = candidates
          .slice(i + 1)
          .find((c) => !skippedProviders.has(c.provider.id) && !(c.key && deadKeys.has(c.key.id)));
        if (next) {
          const reason = err instanceof ProviderError ? err.kind.replace('_', ' ') : 'error';
          const note = combined
            ? `${describeCandidate(candidate)} failed mid-answer (${reason}); continuing on ${describeCandidate(next)}.`
            : `${describeCandidate(candidate)} failed (${reason}); switched to ${describeCandidate(next)}.`;
          notes.push(note);
          this.log.info(note);
          req.onSwitch?.(note);
        }
      }
    }

    if (lastError instanceof ProviderError) {
      const summary = attempts.map((a) => `• ${a.providerName}/${a.model}${a.keyLabel ? ` [${a.keyLabel}]` : ''}: ${a.error}`).join('\n');
      throw this.withPartial(new ProviderError(lastError.kind, `All providers failed.\n${summary}`, lastError.status), combined);
    }
    throw lastError;
  }

  private withPartial(err: unknown, partial: string): unknown {
    if (err instanceof ProviderError && partial) err.partialText = partial;
    return err;
  }

  private async applyFailure(candidate: Candidate, err: unknown, deadKeys: Set<string>, skippedProviders: Set<string>): Promise<void> {
    if (!(err instanceof ProviderError)) {
      skippedProviders.add(candidate.provider.id);
      return;
    }
    const { provider, key } = candidate;
    const retireKey = async (update: Parameters<RouterRegistry['updateKey']>[2]) => {
      if (!key) {
        skippedProviders.add(provider.id);
        return;
      }
      deadKeys.add(key.id);
      await this.registry.updateKey(provider.id, key.id, update);
    };
    switch (err.kind) {
      case 'rate_limit': {
        const until = exhaustedUntil(err.rateLimits, Date.now()) ?? Date.now() + (err.retryAfterMs ?? DEFAULT_COOLDOWN_MS);
        await retireKey({ status: 'cooldown', cooldownUntil: until, lastError: err.message });
        break;
      }
      case 'quota':
        await retireKey({ status: 'exhausted', lastError: err.message });
        break;
      case 'auth':
        await retireKey({ status: 'invalid', lastError: err.message });
        break;
      case 'server':
      case 'network':
      case 'timeout':
        // The whole endpoint is likely affected; move to the next provider.
        skippedProviders.add(provider.id);
        break;
      default:
        break;
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return ['rate_limit', 'quota', 'auth', 'server', 'network', 'timeout'].includes(err.kind);
}
