import { useEffect, useState } from 'react';
import type { AdminState } from '../../../src/shared/protocol';
import type { BudgetPeriod, KeyMeta, ModelConfig, ProviderConfig, ProviderPreset, ProviderRole, TestResult } from '../../../src/shared/types';
import { on, request } from '../rpc';

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function blankProvider(preset: ProviderPreset): ProviderConfig {
  return {
    id: '',
    name: preset.label === 'Custom' ? '' : preset.label,
    kind: 'openai-compatible',
    role: preset.role,
    baseUrl: preset.baseUrl,
    priority: Number.MAX_SAFE_INTEGER,
    enabled: true,
    requiresKey: preset.requiresKey,
    headers: { ...(preset.headers ?? {}) },
    models: preset.exampleModel
      ? [{ id: uid(), model: preset.exampleModel, contextWindow: preset.role === 'context' ? 32768 : 128000, maxOutputTokens: preset.role === 'context' ? 2048 : 8192, enabled: true }]
      : [],
    keys: [],
  };
}

export function Admin() {
  const [state, setState] = useState<AdminState | undefined>();
  const [editing, setEditing] = useState<ProviderConfig | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [, setTick] = useState(0);

  useEffect(() => {
    const off = on('admin/state', setState);
    request('admin/getState', undefined).then(setState, (e: Error) => setError(e.message));
    const timer = setInterval(() => setTick((t) => t + 1), 1000); // refresh cooldown countdowns
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!state) return <div className="admin">{error ?? 'Loading…'}</div>;

  const section = (role: ProviderRole) => state.providers.filter((p) => p.role === role);

  return (
    <div className="admin">
      <header className="admin-header">
        <div>
          <h1>CodeWeave Settings</h1>
          <p className="muted">
            Providers are tried in priority order. Within a provider, keys rotate automatically when one is rate-limited,
            out of quota or rejected; then the next provider is used. Key values are stored in VS Code SecretStorage and
            never shown again.
          </p>
        </div>
        <button className="btn" onClick={() => request('admin/openUsage', undefined)}>
          📊 Usage dashboard
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}

      {editing ? (
        <ProviderForm
          initial={editing}
          onCancel={() => setEditing(undefined)}
          onSave={(p) =>
            run(async () => {
              await request('admin/saveProvider', p);
              setEditing(undefined);
            })
          }
        />
      ) : (
        <AddProvider presets={state.presets} onPick={(preset) => setEditing(blankProvider(preset))} />
      )}

      <h2>Intelligence providers</h2>
      <p className="muted">Cloud models for chat, code generation and planning. Top = highest priority.</p>
      {section('intelligence').length === 0 && <div className="card muted">None yet. Add one above.</div>}
      {section('intelligence').map((p, i, arr) => (
        <ProviderCard key={p.id} provider={p} first={i === 0} last={i === arr.length - 1} onEdit={() => setEditing(p)} run={run} />
      ))}

      <h2>Local context model</h2>
      <p className="muted">
        Used only for summarising long conversations and transferring context when switching providers, so your history is
        not sent to the cloud for that work. Requires a local server such as Ollama (<code>ollama pull qwen2.5:3b</code>).
      </p>
      {section('context').length === 0 && <div className="card muted">None configured.</div>}
      {section('context').map((p, i, arr) => (
        <ProviderCard key={p.id} provider={p} first={i === 0} last={i === arr.length - 1} onEdit={() => setEditing(p)} run={run} />
      ))}
    </div>
  );
}

function AddProvider({ presets, onPick }: { presets: ProviderPreset[]; onPick: (p: ProviderPreset) => void }) {
  return (
    <div className="card add-provider">
      <strong>Add provider</strong>
      <div className="preset-grid">
        {presets.map((p) => (
          <button key={p.label} className="btn" onClick={() => onPick(p)}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function statusText(k: KeyMeta): string {
  if (!k.enabled) return 'disabled';
  if (k.status === 'cooldown') {
    const left = Math.ceil(((k.cooldownUntil ?? 0) - Date.now()) / 1000);
    return left > 0 ? `cooldown ${left}s` : 'active';
  }
  return k.status;
}

function ProviderCard({
  provider: p,
  first,
  last,
  onEdit,
  run,
}: {
  provider: ProviderConfig;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [test, setTest] = useState<TestResult | undefined>();
  const [testing, setTesting] = useState(false);

  const toggleEnabled = () => run(() => request('admin/saveProvider', { ...p, enabled: !p.enabled }));

  return (
    <div className={`card provider ${p.enabled ? '' : 'disabled'}`}>
      <div className="provider-head">
        <div className="provider-title">
          <span className="priority">#{p.priority + 1}</span>
          <strong>{p.name}</strong>
          <span className="muted small">{p.baseUrl}</span>
        </div>
        <div className="actions">
          <button className="icon-btn" disabled={first} title="Higher priority" onClick={() => run(() => request('admin/move', { id: p.id, direction: -1 }))}>
            ▲
          </button>
          <button className="icon-btn" disabled={last} title="Lower priority" onClick={() => run(() => request('admin/move', { id: p.id, direction: 1 }))}>
            ▼
          </button>
          <label className="check">
            <input type="checkbox" checked={p.enabled} onChange={toggleEnabled} /> Enabled
          </label>
          <button
            className="btn"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              setTest(undefined);
              await run(async () => setTest(await request('admin/test', { providerId: p.id })));
              setTesting(false);
            }}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn" onClick={onEdit}>
            Edit
          </button>
          <button className="btn danger" onClick={() => run(() => request('admin/deleteProvider', { id: p.id }))}>
            Delete
          </button>
        </div>
      </div>

      {test && <div className={`banner ${test.ok ? 'ok' : 'error'}`}>{test.message}</div>}
      {test?.ok && !!test.models?.length && (
        <ModelPicker
          available={test.models.filter((id) => !p.models.some((m) => m.model === id))}
          onAdd={(model) =>
            run(() =>
              request('admin/saveProvider', {
                ...p,
                models: [
                  ...p.models,
                  { id: uid(), model, contextWindow: p.role === 'context' ? 8192 : 128000, maxOutputTokens: p.role === 'context' ? 1024 : 8192, enabled: true },
                ],
              }),
            )
          }
        />
      )}

      <div className="subhead">Models (tried in this order)</div>
      {p.models.length === 0 ? (
        <div className="muted small">No models. Click Edit to add one.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Model</th>
              <th>Context window</th>
              <th>Max output</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {p.models.map((m) => (
              <tr key={m.id}>
                <td>
                  <code>{m.model}</code>
                </td>
                <td>{m.contextWindow.toLocaleString()}</td>
                <td>{m.maxOutputTokens.toLocaleString()}</td>
                <td>{m.enabled ? 'enabled' : 'disabled'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {p.requiresKey ? (
        <>
          <div className="subhead">API keys (rotated in this order)</div>
          {p.keys.length === 0 && <div className="muted small">No keys yet.</div>}
          {p.keys.map((k) => (
            <div key={k.id} className="key-row">
              <span className={`badge ${statusText(k).startsWith('cooldown') ? 'cooldown' : statusText(k)}`}>{statusText(k)}</span>
              <strong>{k.label}</strong>
              <code className="muted">{k.hint}</code>
              {k.lastError && k.status !== 'active' && <span className="muted small key-error" title={k.lastError}>{k.lastError}</span>}
              <span className="spacer" />
              <BudgetEditor providerId={p.id} k={k} run={run} />
              {k.status !== 'active' && (
                <button className="btn" onClick={() => run(() => request('admin/resetKey', { providerId: p.id, keyId: k.id }))}>
                  Mark active
                </button>
              )}
              <button className="btn danger" onClick={() => run(() => request('admin/deleteKey', { providerId: p.id, keyId: k.id }))}>
                Remove
              </button>
            </div>
          ))}
          <form
            className="key-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!secret.trim()) return;
              void run(async () => {
                await request('admin/addKey', { providerId: p.id, label, secret });
                setLabel('');
                setSecret('');
              });
            }}
          >
            <input placeholder="Label (e.g. Personal)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input type="password" autoComplete="off" placeholder="Paste API key" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <button className="btn primary" type="submit" disabled={!secret.trim()}>
              Add key
            </button>
          </form>
        </>
      ) : (
        <div className="muted small">No API key required (local server).</div>
      )}
    </div>
  );
}

function ProviderForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: ProviderConfig;
  onSave: (p: ProviderConfig) => void;
  onCancel: () => void;
}) {
  const [p, setP] = useState<ProviderConfig>(initial);
  const [headersText, setHeadersText] = useState(
    Object.entries(initial.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  );

  const setModel = (id: string, patch: Partial<ModelConfig>) =>
    setP((prev) => ({ ...prev, models: prev.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));

  const moveModel = (index: number, dir: -1 | 1) =>
    setP((prev) => {
      const models = [...prev.models];
      const j = index + dir;
      if (j < 0 || j >= models.length) return prev;
      [models[index], models[j]] = [models[j], models[index]];
      return { ...prev, models };
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const headers: Record<string, string> = {};
    for (const line of headersText.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    onSave({ ...p, headers });
  };

  return (
    <form className="card form" onSubmit={submit}>
      <strong>{initial.id ? `Edit ${initial.name}` : 'New provider'}</strong>
      <div className="form-grid">
        <label>
          Name
          <input required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </label>
        <label>
          Base URL (OpenAI-compatible, usually ends in /v1)
          <input required value={p.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setP({ ...p, baseUrl: e.target.value })} />
        </label>
        <label>
          Role
          <select value={p.role} onChange={(e) => setP({ ...p, role: e.target.value as ProviderRole })}>
            <option value="intelligence">Intelligence (cloud: chat, code, planning)</option>
            <option value="context">Context (local: summarisation only)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.requiresKey} onChange={(e) => setP({ ...p, requiresKey: e.target.checked })} />
          Requires API key
        </label>
        <label className="wide">
          Extra headers (one "Name: value" per line; not for API keys)
          <textarea rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
        </label>
      </div>

      <div className="subhead">Models</div>
      <table className="grid">
        <thead>
          <tr>
            <th>Model ID</th>
            <th>Context window</th>
            <th>Max output</th>
            <th>Enabled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {p.models.map((m, i) => (
            <tr key={m.id}>
              <td>
                <input required value={m.model} placeholder="e.g. gpt-4o-mini" onChange={(e) => setModel(m.id, { model: e.target.value })} />
              </td>
              <td>
                <input type="number" min={1024} value={m.contextWindow} onChange={(e) => setModel(m.id, { contextWindow: Number(e.target.value) })} />
              </td>
              <td>
                <input type="number" min={64} value={m.maxOutputTokens} onChange={(e) => setModel(m.id, { maxOutputTokens: Number(e.target.value) })} />
              </td>
              <td>
                <input type="checkbox" checked={m.enabled} onChange={(e) => setModel(m.id, { enabled: e.target.checked })} />
              </td>
              <td className="actions">
                <button type="button" className="icon-btn" onClick={() => moveModel(i, -1)} disabled={i === 0}>▲</button>
                <button type="button" className="icon-btn" onClick={() => moveModel(i, 1)} disabled={i === p.models.length - 1}>▼</button>
                <button type="button" className="icon-btn" onClick={() => setP({ ...p, models: p.models.filter((x) => x.id !== m.id) })}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="btn"
        onClick={() =>
          setP({ ...p, models: [...p.models, { id: uid(), model: '', contextWindow: 128000, maxOutputTokens: 8192, enabled: true }] })
        }
      >
        + Add model
      </button>
      <p className="muted small">
        Set the context window and max output from your provider's model documentation; CodeWeave uses them to fit
        conversations into the model without overflow. API keys are added on the provider card after saving.
      </p>

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Save provider
        </button>
      </div>
    </form>
  );
}

const PERIOD_LABEL: Record<BudgetPeriod, string> = { day: 'per day', month: 'per month', total: 'in total' };

/** A token budget is the user's own cap; when reached, the key is skipped until the period resets. */
function BudgetEditor({ providerId, k, run }: { providerId: string; k: KeyMeta; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState(String(k.budget?.tokens ?? ''));
  const [period, setPeriod] = useState<BudgetPeriod>(k.budget?.period ?? 'month');

  if (!open) {
    return (
      <button className="btn" title="Set a token budget for this key" onClick={() => setOpen(true)}>
        {k.budget ? `Budget: ${k.budget.tokens.toLocaleString()} ${PERIOD_LABEL[k.budget.period]}` : 'Set budget'}
      </button>
    );
  }
  return (
    <form
      className="budget-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await request('admin/setBudget', { providerId, keyId: k.id, budget: { tokens: Number(tokens), period } });
          setOpen(false);
        });
      }}
    >
      <input type="number" min={1} required placeholder="Tokens" value={tokens} onChange={(e) => setTokens(e.target.value)} />
      <select value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}>
        <option value="day">per day</option>
        <option value="month">per month</option>
        <option value="total">in total</option>
      </select>
      <button className="btn primary" type="submit">Save</button>
      {k.budget && (
        <button
          className="btn"
          type="button"
          onClick={() =>
            run(async () => {
              await request('admin/setBudget', { providerId, keyId: k.id, budget: null });
              setTokens('');
              setOpen(false);
            })
          }
        >
          Remove
        </button>
      )}
      <button className="btn" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

/** Search the models an endpoint reported and add one without typing its exact ID. */
function ModelPicker({ available, onAdd }: { available: string[]; onAdd: (model: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const listId = useState(() => `models-${uid()}`)[0];
  const valid = available.includes(value);
  return (
    <form
      className="key-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void onAdd(value).then(() => setValue(''));
      }}
    >
      <input
        list={listId}
        value={value}
        placeholder={`Search ${available.length} available model(s) to add…`}
        onChange={(e) => setValue(e.target.value)}
      />
      <datalist id={listId}>
        {available.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <button className="btn" type="submit" disabled={!valid} title="Adds it with default limits; check them with Edit">
        Add model
      </button>
    </form>
  );
}
