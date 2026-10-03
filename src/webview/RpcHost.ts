import type * as vscode from 'vscode';
import type { EventName, Events, HostToWebview, MethodName, Methods, WebviewToHost } from '../shared/protocol';

export type Handlers = Partial<{
  [M in MethodName]: (params: Methods[M]['params']) => Promise<Methods[M]['result']> | Methods[M]['result'];
}>;

/** Binds typed request handlers to a webview and lets the host push typed events. */
export class RpcHost {
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly handlers: Handlers,
    onError: (method: string, err: unknown) => void,
  ) {
    this.sub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      if (!msg || msg.kind !== 'req') return;
      const handler = this.handlers[msg.method] as ((p: unknown) => unknown) | undefined;
      let reply: HostToWebview;
      try {
        if (!handler) throw new Error(`Unknown method: ${msg.method}`);
        reply = { kind: 'res', id: msg.id, result: await handler(msg.params) };
      } catch (err) {
        onError(msg.method, err);
        reply = { kind: 'res', id: msg.id, error: err instanceof Error ? err.message : String(err) };
      }
      void this.webview.postMessage(reply);
    });
  }

  emit<E extends EventName>(name: E, payload: Events[E]): void {
    const msg: HostToWebview = { kind: 'event', name, payload };
    void this.webview.postMessage(msg);
  }

  dispose(): void {
    this.sub.dispose();
  }
}
