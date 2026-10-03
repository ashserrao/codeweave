import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export type ViewName = 'chat' | 'admin' | 'usage';

/** HTML shell for the React bundle with a strict CSP (nonce-gated scripts, no remote content). */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: ViewName): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', file));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${asset('index.css')}" />
  <title>CodeWeave</title>
</head>
<body data-view="${view}">
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${asset('index.js')}"></script>
</body>
</html>`;
}
