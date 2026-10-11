# CodeWeave

A coding intelligence that weaves together code, memory, architecture, and AI providers into one ecosystem.

Tagline: Your code. Connected intelligence.

> **Status: v0.3.0. Phases 1–3 of 7 are complete** (foundation, resilience and approvals): providers, key rotation and fallback, streaming chat, usage dashboard and budgets, local-model summarisation, and **reviewed code changes with Accept/Reject**. Agent mode, code memory (MCP knowledge graph) and the documentation manager arrive in later phases. See [Roadmap](#roadmap).

## What works in v0.2.0

- **Chat sidebar** laid out like GitHub Copilot Chat: avatar-and-name turns, streaming answers, code blocks with a hover copy button, and a rounded input with a searchable **model picker** (Auto, or any model grouped by provider). The title bar has New Chat, **History** (a searchable Quick Pick with delete), Usage and Settings.
- **Editor context chip.** The input shows the current file or selection (for example `SearchBox.tsx:12-28`). Click the chip (eye icon) to include or exclude it from your next message.
- **Settings & Providers dashboard** for adding any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, the OmniRoute gateway, LM Studio, Ollama or a custom one), with models and multiple API keys per provider. After **Test connection**, you can search the endpoint's model list and add models without typing their IDs.
- **Priority routing.** Providers are tried top to bottom, and models within a provider in order. You can also pin a specific model from the chat's model picker.
- **Automatic key rotation and fallback:**
  - A rate-limited key (HTTP 429) cools down for the provider's `retry-after` / reset time, and the next key is used.
  - A key that runs out of quota or credit is marked *exhausted*, and the next key is used.
  - A rejected key (401/403) is marked *invalid*, and the next key is used.
  - Server errors, network errors and timeouts make CodeWeave move on to the next provider.
  - If a reply has already started streaming, CodeWeave keeps the partial answer instead of silently re-sending the request.
- **Honest token counts.** Each reply shows input/output tokens. They are marked *(est.)* when the provider didn't report usage and CodeWeave had to estimate.
- **Secure keys.** API keys are stored only in VS Code SecretStorage (the OS keychain). The dashboard shows a masked hint such as `sk-…a1b2`.
- **Usage dashboard** (📊 in the chat toolbar, or **CodeWeave: Open Usage Dashboard**). It shows tokens per key for today, this month and all time, usable keys, budget meters, rate-limit windows and account balances. Every figure has a source label:
  - **Reported:** came from the provider, either from `x-ratelimit-*` response headers or from a balance API (OpenRouter and DeepSeek have one).
  - **Counted:** CodeWeave counted it from each response's `usage` field. Any part the provider didn't report is estimated and shown separately as "est.".
  - **Your budget:** your own token cap minus the counted usage. It is not a provider quota.
  - **"—"** means the provider doesn't expose this value. CodeWeave never guesses.
- **Token budgets per key** (daily, monthly or total), set in Settings & Providers. When a key reaches its budget it is skipped automatically, and it comes back when the period resets.
- **Proactive cooldown.** If a provider's headers say a key's request or token window is used up, the key rests until the reset time instead of failing on the next request.
- **Local context model.** When a conversation no longer fits the selected model, the oldest turns are condensed into a rolling summary by the local model (Ollama `qwen2.5:3b` by default). The summary is saved with the conversation and only regenerated when more room is needed. Conversation text is never sent to a cloud provider for summarisation. Without a local model, the oldest turns are left out instead, and the reply tells you so.
- **Context transfer.** If a provider fails mid-reply (dropped connection, overload, rate limit), the next key or provider receives the partial answer and continues from where it stopped. Each reply shows which switches happened (⇄) and how the context was fitted (✂).
- **"Context too long" recovery.** If a provider rejects a prompt as too long, CodeWeave shrinks the context (summarising if possible) and retries once.
- **Status bar.** Shows today's token count; click it to open the dashboard. It turns into a warning when no key is usable.

## Reviewing changes (Accept / Reject)

CodeWeave never changes a file or runs a command on its own. When the model proposes changes, they appear in a **Changes card** under its reply:

- **Each file** shows its path and `+added −removed` lines. Click the name (or the diff icon) to review it in VS Code's diff editor, then **✓ Accept** or **✕ Reject**. After applying, **Undo** restores the previous version, unless you've edited the file again since.
- **Accept all / Reject all** act on every pending file change in the card.
- **Commands** show the exact command and folder. They run only when you click **Run** (one at a time, never through Accept all), in a *CodeWeave* terminal. Exit code and output appear in the card, and **Ask about this output** puts them in the chat input.
- **Safe re-application.** If a file changed after the proposal was made, Accept doesn't overwrite it. CodeWeave re-applies the proposal on top of your edits, refreshes the diff, and asks you to accept again.
- **Changes that can't be applied** are shown with the reason, for example when the text to replace isn't in the file, or a path is outside the workspace (`..`, absolute paths, `.git`). Nothing is written for them.
- **Apply to editor** (▸ icon on any ordinary code block) turns that code into a pending change for the current selection, or inserts it after the cursor line. You review the diff before anything is written.
- **Fix with CodeWeave** appears in the 💡 lightbulb on errors and warnings. The editor's right-click menu has **CodeWeave → Explain / Fix Problems / Refactor / Generate Tests**.

How it works: models are asked to write changes as fenced blocks tagged `path=…` with `SEARCH/REPLACE` sections (or a full file, or `delete`), and commands as ````shell run```` blocks. Proposed file contents are kept in CodeWeave's private storage, not your repo. Only one module (`src/approval/Applier.ts`) can write files or run commands, and an automated test fails the build if any other code tries.

## Install from the .vsix

1. In VS Code, open the Extensions view (`Ctrl+Shift+X`), click the `…` menu, choose **Install from VSIX…** and pick `codeweave-0.3.0.vsix`.
   Or, from a terminal:
   ```
   code --install-extension codeweave-0.3.0.vsix
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

### Using OmniRoute (AI gateway)

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is a self-hosted gateway that puts many providers behind one OpenAI-compatible endpoint, with its own fallback "combos".

1. Run OmniRoute (`npm install -g omniroute`, then `omniroute`; or use Docker). Open its dashboard at `http://localhost:20128`, connect your providers, and create an API key in its **API Manager**.
2. In CodeWeave Settings, click the **OmniRoute (gateway)** preset and **Save provider**. It fills in:
   - Base URL `http://localhost:20128/v1`
   - The `x-omniroute-no-memory: true` header, which stops OmniRoute adding its own memory and skills to prompts. CodeWeave already sends the context it needs, and that extra text costs tokens.
3. Paste the OmniRoute key on the provider card, then click **Test connection**.
4. Use the **search box** that appears under the test result to add models. You can add single models (`cc/claude-…`) or combos (for example `auto/coding`). Each model is listed once, even though OmniRoute reports both alias and canonical names. Check each model's context window with **Edit**.
5. Replies routed through OmniRoute show **"via &lt;provider&gt;"**, so you can see which upstream answered.

Notes:
- **Two layers of fallback.** OmniRoute falls back inside a combo. CodeWeave's own key rotation and fallback still apply on top, for example to another provider when OmniRoute itself is down.
- **Unchecked key setting.** If you started OmniRoute without key checking, untick *Requires API key*.
- **Usage counts.** The CodeWeave dashboard counts tokens that pass through OmniRoute like any other provider. OmniRoute's own quota and cost endpoints aren't read yet; use OmniRoute's dashboard for those.

### Optional: budgets and balances

- **Budget:** on a key's row, click **Set budget**, then enter a number of tokens and a period. The Usage dashboard shows a meter for it. When the budget runs out, CodeWeave moves to the key's sibling keys or to the next provider.
- **Balance:** for OpenRouter and DeepSeek keys, click **Refresh balances** in the Usage dashboard to fetch the account credit from the provider. Balances are only checked when you click; CodeWeave never polls in the background.

### Local context model (recommended)

The local model condenses long conversations so they fit the cloud model. Conversation text is never sent to the cloud for this.

1. **Install Ollama** from https://ollama.com/download. On Windows, run `OllamaSetup.exe`. Ollama then runs in the background at `http://localhost:11434`.
2. **Download the model** (about 1.9 GB; runs on a CPU with about 3–4 GB of free RAM):
   ```
   ollama pull qwen2.5:3b
   ollama list
   ```
3. **Match the context length.** Ollama reads at most its configured context length per request (often 4096 tokens by default) and silently cuts off anything longer. Raise it, and set CodeWeave to the same value:
   - In Ollama, set **Settings → Context length** to `8192`. Or run `setx OLLAMA_CONTEXT_LENGTH 8192` and restart Ollama from the tray icon.
   - In CodeWeave, open **Settings & Providers → Local context model → Edit**, set *Context window* to `8192` and *Max output* to `1024`, then save.
4. **Click Test connection** on the *Local context model* card. You should see *"Connected"* with no "model not in the list" warning.

The card comes pre-filled with base URL `http://localhost:11434/v1` and model `qwen2.5:3b`, and no key is needed. LM Studio or any other OpenAI-compatible local server also works: add it with the role **Context**.

## Settings (`settings.json`)

| Setting | Default | Purpose |
|---|---|---|
| `codeweave.chat.includeActiveEditor` | `true` | Attach the selection or file excerpt by default |
| `codeweave.chat.maxEditorContextChars` | `24000` | Size limit for attached editor content |
| `codeweave.request.timeoutSeconds` | `120` | Abort a request when nothing has arrived for this long |
| `codeweave.chat.systemPrompt` | `""` | Extra instructions added to the system prompt |
| `codeweave.context.summarize` | `true` | Condense older turns with the local context model instead of dropping them |

Provider, model, key and budget metadata, and the usage history (kept for about 13 months), live in VS Code's global state. Key values live in SecretStorage. None of this is written to `settings.json`, so it is never synced or committed by accident.

## Commands

| Command | Shortcut |
|---|---|
| CodeWeave: New Chat | none |
| CodeWeave: Open Settings & Providers | none |
| CodeWeave: Open Usage Dashboard | none |
| CodeWeave: Cancel Current Request | none |
| CodeWeave: Ask CodeWeave About Selection | `Ctrl+Shift+L` (`Cmd+Shift+L` on macOS) |
| CodeWeave: Show Chat History | none |
| CodeWeave: Explain / Fix Problems / Refactor / Generate Tests | none (editor right-click → CodeWeave) |
| Fix with CodeWeave | 💡 lightbulb on an error or warning |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Reply says *"…every API key is exhausted, invalid, cooling down, over its budget or disabled"* | Open the Usage dashboard to see each key's status. Use **Mark active** in Settings for keys you have topped up, or raise or remove budgets. |
| Every reply has a ⇄ note | The top-priority provider keeps failing. The note and **Output → CodeWeave** show why (rate limit, auth, network). |
| ✂ note says older messages were *left out* | No local context model is reachable. Start Ollama and click **Test connection** on its card. |
| Summaries miss earlier details | Ollama's context length is smaller than the *Context window* set on the card. Make them match (see above). |
| *"Configured model(s) not in the list"* after **Test connection** | The model ID doesn't exactly match the provider's list, or for Ollama, `ollama pull` didn't finish. |
| Reply ends with *"stopped at the model's max output tokens"* | Ask the model to continue, or raise *Max output* on the model. |

## Development

```
npm install
npm run build        # webview (Vite) + extension (esbuild) into dist/
npm run typecheck
npm test             # 63 unit, mock-server and architecture tests (vitest)
npm run package      # typecheck, then produce codeweave-<version>.vsix
```
Press **F5** in VS Code to launch an Extension Development Host. The *Run CodeWeave* launch config builds first. Logs go to the **Output → CodeWeave** channel. To debug the webview, run **Developer: Open Webview Developer Tools** inside the host.

### Project layout

```
src/
  extension.ts            activation and wiring
  shared/                 types and the RPC protocol shared with the webview
  secrets/KeyVault.ts     SecretStorage wrapper (the only place key values are handled)
  providers/              OpenAI-compatible adapter, SSE parser, error classifier, rate-limit header parser,
                          candidate ordering, Router (rotation, fallback, context transfer), registry, presets
  usage/                  UsageLedger (token accounting), balance probes, dashboard model, status bar
  approval/               change-format parser, SEARCH/REPLACE engine, path safety, ProposalStore,
                          ApprovalService (cards, diffs, accept/reject/undo), Applier (the only writer)
  core/                   ChatService, ContextService (local summarisation), ContextPacker,
                          ConversationStore, EditorContext, Logger
  webview/                webview hosting: CSP HTML shell, typed RPC host, chat view, admin and usage panels
webview-ui/               React UI (chat, settings, usage) built with Vite
test/                     vitest suites
```

## Roadmap

1. ✅ Foundation: providers, keys, routing, streaming chat
2. ✅ Resilience: usage ledger and dashboard (reported vs. estimated), budgets, proactive cooldown, local-model summarisation, context transfer during fallback
3. ✅ Approvals: diffs, per-item and bulk Accept/Reject, Undo, stale-file protection, approved terminal execution, Apply to editor, Fix with CodeWeave
4. Code memory: tree-sitter + SQLite knowledge graph, exposed through an in-process MCP server, plus external MCP servers
5. Agent mode: workspace analysis, planning, tool loop, test-and-fix iteration
6. Documentation manager: onboarding questions, `prd.md`, `architecture.md`, `rules.md`, `design.md`, `tasks.md`, `memory.md`, plus `changelog.md` synced from Git
7. Hardening and full documentation
