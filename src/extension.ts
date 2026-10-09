import * as vscode from 'vscode';
import { Logger } from './core/Logger';
import { KeyVault } from './secrets/KeyVault';
import { ProviderRegistry } from './providers/ProviderRegistry';
import { OpenAICompatAdapter } from './providers/OpenAICompatAdapter';
import { Router } from './providers/Router';
import { ConversationStore } from './core/ConversationStore';
import { EditorContext } from './core/EditorContext';
import { ContextService } from './core/ContextService';
import { ChatService } from './core/ChatService';
import { UsageLedger } from './usage/UsageLedger';
import { UsageService } from './usage/UsageService';
import { UsageStatusBar } from './usage/UsageStatusBar';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { AdminPanel } from './webview/AdminPanel';
import { UsagePanel } from './webview/UsagePanel';
import { Applier } from './approval/Applier';
import { ApprovalService, PROPOSAL_SCHEME } from './approval/ApprovalService';
import { ProposalStore } from './approval/ProposalStore';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new Logger();
  const registry = new ProviderRegistry(context.globalState, new KeyVault(context.secrets));
  await registry.seedDefaults();

  const ledger = new UsageLedger(context.globalState);
  const usage = new UsageService(ledger, registry);
  const adapter = new OpenAICompatAdapter();
  const router = new Router(registry, adapter, ledger, log);
  const contextService = new ContextService(router);
  const storageRoot = context.storageUri ?? context.globalStorageUri;
  const store = new ConversationStore(storageRoot);
  const editor = new EditorContext();
  const applier = new Applier();
  const approvals = new ApprovalService(new ProposalStore(storageRoot), applier, log);
  const chat = new ChatService(store, registry, router, contextService, approvals, editor, context.workspaceState, log);
  await chat.restore();

  const chatView = new ChatViewProvider(context.extensionUri, chat, log);

  context.subscriptions.push(
    log,
    registry,
    usage,
    editor,
    chat,
    chatView,
    applier,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, approvals),
    new UsageStatusBar(usage),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codeweave.newChat', () => chat.newConversation()),
    vscode.commands.registerCommand('codeweave.openAdmin', () =>
      AdminPanel.show(context.extensionUri, registry, adapter, usage, log),
    ),
    vscode.commands.registerCommand('codeweave.openUsage', () => UsagePanel.show(context.extensionUri, usage, log)),
    vscode.commands.registerCommand('codeweave.cancelRequest', () => chat.cancel()),
    vscode.commands.registerCommand('codeweave.askAboutSelection', () =>
      chatView.prefill('Explain the selected code and point out any bugs or improvements.'),
    ),
  );

  log.info('CodeWeave activated');
}

export function deactivate(): void {
  /* disposables are cleaned up via context.subscriptions */
}
