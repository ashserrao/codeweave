import * as vscode from 'vscode';
import type { KeyMeta, ProviderConfig } from '../shared/types';
import { KeyVault } from '../secrets/KeyVault';
import { newId } from '../core/ids';

const STORAGE_KEY = 'codeweave.providers.v1';
const SEEDED_KEY = 'codeweave.providers.seeded';

/** Default local context model (summarisation / context transfer only). Editable in the Admin Dashboard. */
function defaultLocalContextProvider(): ProviderConfig {
  return {
    id: newId(),
    name: 'Ollama (local context)',
    kind: 'openai-compatible',
    role: 'context',
    baseUrl: 'http://localhost:11434/v1',
    priority: 0,
    enabled: true,
    requiresKey: false,
    headers: {},
    models: [{ id: newId(), model: 'qwen2.5:3b', contextWindow: 32768, maxOutputTokens: 2048, enabled: true }],
    keys: [],
  };
}

/**
 * Owns provider / model / key metadata (globalState, synced across workspaces on this machine).
 * Secret key values are delegated to KeyVault.
 */
export class ProviderRegistry implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly state: vscode.Memento,
    readonly vault: KeyVault,
  ) {}

  async seedDefaults(): Promise<void> {
    if (this.state.get<boolean>(SEEDED_KEY)) return;
    if (this.list().length === 0) await this.write([defaultLocalContextProvider()]);
    await this.state.update(SEEDED_KEY, true);
  }

  list(): ProviderConfig[] {
    const providers = this.state.get<ProviderConfig[]>(STORAGE_KEY, []);
    return [...providers].sort((a, b) => a.priority - b.priority);
  }

  get(id: string): ProviderConfig | undefined {
    return this.list().find((p) => p.id === id);
  }

  byRole(role: ProviderConfig['role']): ProviderConfig[] {
    return this.list().filter((p) => p.role === role);
  }

  private async write(providers: ProviderConfig[]): Promise<void> {
    // Normalise priorities to 0..n-1 within each role so ordering stays stable.
    const normalised: ProviderConfig[] = [];
    for (const role of ['intelligence', 'context'] as const) {
      providers
        .filter((p) => p.role === role)
        .sort((a, b) => a.priority - b.priority)
        .forEach((p, i) => normalised.push({ ...p, priority: i }));
    }
    await this.state.update(STORAGE_KEY, normalised);
    this.changed.fire();
  }

  async save(input: ProviderConfig): Promise<void> {
    const provider = validate(input);
    const all = this.list();
    const index = all.findIndex((p) => p.id === provider.id);
    if (index === -1) {
      provider.priority = all.filter((p) => p.role === provider.role).length;
      provider.keys = [];
      all.push(provider);
    } else {
      const existing = all[index];
      // Keys are managed via addKey/deleteKey; never accept key metadata from the UI wholesale.
      const roleChanged = existing.role !== provider.role;
      all[index] = {
        ...provider,
        keys: existing.keys,
        priority: roleChanged ? Number.MAX_SAFE_INTEGER : provider.priority,
        supportsStreamUsage: existing.baseUrl === provider.baseUrl ? existing.supportsStreamUsage : undefined,
      };
    }
    await this.write(all);
  }

  async delete(id: string): Promise<void> {
    const provider = this.get(id);
    if (!provider) return;
    await Promise.all(provider.keys.map((k) => this.vault.delete(id, k.id)));
    await this.write(this.list().filter((p) => p.id !== id));
  }

  async move(id: string, direction: -1 | 1): Promise<void> {
    const all = this.list();
    const provider = all.find((p) => p.id === id);
    if (!provider) return;
    const peers = all.filter((p) => p.role === provider.role);
    const i = peers.findIndex((p) => p.id === id);
    const j = i + direction;
    if (j < 0 || j >= peers.length) return;
    [peers[i].priority, peers[j].priority] = [peers[j].priority, peers[i].priority];
    await this.write(all);
  }

  async addKey(providerId: string, label: string, secret: string): Promise<void> {
    const provider = this.get(providerId);
    const value = secret.trim();
    if (!provider) throw new Error('Provider not found');
    if (!value) throw new Error('API key is empty');
    const key: KeyMeta = {
      id: newId(),
      label: label.trim() || `Key ${provider.keys.length + 1}`,
      hint: KeyVault.mask(value),
      enabled: true,
      status: 'active',
    };
    await this.vault.set(providerId, key.id, value);
    await this.patch(providerId, (p) => ({ ...p, keys: [...p.keys, key] }));
  }

  async deleteKey(providerId: string, keyId: string): Promise<void> {
    await this.vault.delete(providerId, keyId);
    await this.patch(providerId, (p) => ({ ...p, keys: p.keys.filter((k) => k.id !== keyId) }));
  }

  async updateKey(providerId: string, keyId: string, update: Partial<KeyMeta>): Promise<void> {
    await this.patch(providerId, (p) => ({
      ...p,
      keys: p.keys.map((k) => (k.id === keyId ? { ...k, ...update } : k)),
    }));
  }

  async setStreamUsageSupport(providerId: string, supported: boolean): Promise<void> {
    await this.patch(providerId, (p) => ({ ...p, supportsStreamUsage: supported }));
  }

  private async patch(providerId: string, fn: (p: ProviderConfig) => ProviderConfig): Promise<void> {
    await this.write(this.list().map((p) => (p.id === providerId ? fn(p) : p)));
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function validate(p: ProviderConfig): ProviderConfig {
  const name = p.name?.trim();
  if (!name) throw new Error('Provider name is required');
  let url: URL;
  try {
    url = new URL(p.baseUrl.trim());
  } catch {
    throw new Error('Base URL must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Base URL must use http or https');
  const models = (p.models ?? [])
    .map((m) => ({
      id: m.id || newId(),
      model: m.model.trim(),
      contextWindow: Math.max(1024, Math.floor(Number(m.contextWindow) || 8192)),
      maxOutputTokens: Math.max(64, Math.floor(Number(m.maxOutputTokens) || 2048)),
      enabled: m.enabled !== false,
    }))
    .filter((m) => m.model);
  for (const m of models) {
    if (m.maxOutputTokens >= m.contextWindow) {
      throw new Error(`Model "${m.model}": max output tokens must be smaller than the context window`);
    }
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.headers ?? {})) {
    if (k.trim() && /^authorization$/i.test(k.trim())) {
      throw new Error('Put API keys in the Keys section (stored in SecretStorage), not in headers');
    }
    if (k.trim()) headers[k.trim()] = String(v);
  }
  return {
    id: p.id || newId(),
    name,
    kind: 'openai-compatible',
    role: p.role === 'context' ? 'context' : 'intelligence',
    baseUrl: url.toString().replace(/\/+$/, ''),
    priority: Number.isFinite(p.priority) ? p.priority : Number.MAX_SAFE_INTEGER,
    enabled: p.enabled !== false,
    requiresKey: p.requiresKey !== false,
    headers,
    models,
    keys: p.keys ?? [],
    supportsStreamUsage: p.supportsStreamUsage,
  };
}
