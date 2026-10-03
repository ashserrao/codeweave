# CodeWeave

A coding intelligence that weaves together code, memory, architecture, and AI providers into one ecosystem.

Tagline: Your code. Connected intelligence.

> **Status: v0.1.0, Phase 1 of 7 (foundation).** This release covers providers, key management, routing with key rotation and fallback, and a streaming chat. Agent mode, file editing with approvals, code memory (MCP knowledge graph), the usage dashboard and the documentation manager arrive in later phases. See [Roadmap](#roadmap).

## What works in v0.1.0

- **Chat sidebar** with streaming responses, Stop (cancellation), saved per-workspace history, and copyable code blocks.
- **Editor context.** The current selection, or a bounded excerpt of the active file, is attached to your message. Toggle it with *Include active editor*.
- **Settings & Providers dashboard** for adding any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, LM Studio, Ollama or a custom one), with models and multiple API keys per provider.
- **Priority routing.** Providers are tried top to bottom, and models within a provider in order. You can also pin a specific model from the chat's model picker.
- **Automatic key rotation and fallback:**
  - A rate-limited key (HTTP 429) cools down for the provider's `retry-after` / reset time, and the next key is used.
  - A key that runs out of quota or credit is marked *exhausted*, and the next key is used.
  - A rejected key (401/403) is marked *invalid*, and the next key is used.
  - Server errors, network errors and timeouts make CodeWeave move on to the next provider.
  - If a reply has already started streaming, CodeWeave keeps the partial answer instead of silently re-sending the request.
- **Honest token counts.** Each reply shows input/output tokens. They are marked *(est.)* when the provider didn't report usage and CodeWeave had to estimate.
- **Secure keys.** API keys are stored only in VS Code SecretStorage (the OS keychain). The dashboard shows a masked hint such as `sk-…a1b2`.
- **Local context model slot.** An Ollama provider for `qwen2.5:3b` is pre-configured with the *context* role. It is reserved for conversation summarisation and context transfer (wired up in Phase 2) and is never used to answer chat messages.

## Install from the .vsix

1. In VS Code, open the Extensions view (`Ctrl+Shift+X`), click the `…` menu, choose **Install from VSIX…** and pick `codeweave-0.1.0.vsix`.
   Or, from a terminal:
   ```
   code --install-extension codeweave-0.1.0.vsix
   ```
2. Reload VS Code if prompted. A **CodeWeave** icon appears in the Activity Bar.

Requires VS Code 1.95 or newer.

## Configure a provider

1. Open the CodeWeave view, then click the gear icon (or run **CodeWeave: Open Settings & Providers** from the Command Palette).
2. Under **Add provider**, pick a preset such as *OpenAI* or *OpenRouter*, or choose *Custom* for any OpenAI-compatible base URL.
3. Check the model ID, **context window** and **max output tokens** against the provider's documentation, then click **Save provider**.
4. On the provider card, paste an API key and click **Add key**. Add more keys to enable rotation.
5. Click **Test connection**. This lists the endpoint's models, which checks the URL and key without spending tokens.
6. Use ▲/▼ to set provider priority.

### Optional: local context model

```
ollama pull qwen2.5:3b
```
CodeWeave expects Ollama at `http://localhost:11434/v1`. You can change the URL or model on the *Local context model* card.

## Settings (`settings.json`)

| Setting | Default | Purpose |
|---|---|---|
| `codeweave.chat.includeActiveEditor` | `true` | Attach the selection or file excerpt by default |
| `codeweave.chat.maxEditorContextChars` | `24000` | Size limit for attached editor content |
| `codeweave.request.timeoutSeconds` | `120` | Abort a request when nothing has arrived for this long |
| `codeweave.chat.systemPrompt` | `""` | Extra instructions added to the system prompt |

Provider, model and key metadata live in VS Code's global state, and key values live in SecretStorage. None of this is written to `settings.json`, so it is never synced or committed by accident.

## Commands

| Command | Shortcut |
|---|---|
| CodeWeave: New Chat | none |
| CodeWeave: Open Settings & Providers | none |
| CodeWeave: Cancel Current Request | none |
| CodeWeave: Ask CodeWeave About Selection | `Ctrl+Shift+L` (`Cmd+Shift+L` on macOS) |

## Development

```
npm install
npm run build        # webview (Vite) + extension (esbuild) into dist/
npm run typecheck
npm test             # unit and mock-server tests (vitest)
npm run package      # typecheck, then produce codeweave-<version>.vsix
```
Press **F5** in VS Code to launch an Extension Development Host. The *Run CodeWeave* launch config builds first. Logs go to the **Output → CodeWeave** channel. To debug the webview, run **Developer: Open Webview Developer Tools** inside the host.

### Project layout

```
src/
  extension.ts            activation and wiring
  shared/                 types and the RPC protocol shared with the webview
  secrets/KeyVault.ts     SecretStorage wrapper (the only place key values are handled)
  providers/              OpenAI-compatible adapter, SSE parser, error classifier,
                          candidate ordering, Router (rotation and fallback), registry, presets
  core/                   ChatService, ConversationStore, ContextPacker, EditorContext, Logger
  webview/                webview hosting: CSP HTML shell, typed RPC host, chat view, admin panel
webview-ui/               React UI (chat and settings) built with Vite
test/                     vitest suites
```

## Roadmap

1. ✅ Foundation: providers, keys, routing, streaming chat
2. Resilience: usage ledger and dashboard (reported vs. estimated quotas), local-model summarisation, context transfer during fallback
3. Approvals: diffs, per-item and bulk Accept/Reject, approved terminal execution
4. Code memory: tree-sitter + SQLite knowledge graph, exposed through an in-process MCP server, plus external MCP servers
5. Agent mode: workspace analysis, planning, tool loop, test-and-fix iteration
6. Documentation manager: onboarding questions, `prd.md`, `architecture.md`, `rules.md`, `design.md`, `tasks.md`, `memory.md`, plus `changelog.md` synced from Git
7. Hardening and full documentation
