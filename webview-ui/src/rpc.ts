import type { EventName, Events, HostToWebview, MethodName, Methods } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<EventName, Set<(payload: unknown) => void>>();

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'res') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  } else if (msg.kind === 'event') {
    listeners.get(msg.name)?.forEach((fn) => fn(msg.payload));
  }
});

export function request<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ kind: 'req', id, method, params });
  });
}

export function on<E extends EventName>(name: E, fn: (payload: Events[E]) => void): () => void {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  const handler = fn as (payload: unknown) => void;
  set.add(handler);
  return () => set!.delete(handler);
}
