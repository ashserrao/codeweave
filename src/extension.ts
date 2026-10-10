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
import { registerEditorActions } from './core/editorActions';

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

  const chatView = new ChatViewProvider(context.extensionUri, chat, editor, log);

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
    vscode.commands.registerCommand('codeweave.showHistory', () => showHistory(chat)),
    ...registerEditorActions(chat),
    vscode.commands.registerCommand('codeweave.askAboutSelection', () =>
      chatView.prefill('Explain the selected code and point out any bugs or improvements.'),
    ),
  );

  log.info('CodeWeave activated');
}

/** Chat history as a Quick Pick (like Copilot Chat): pick to open, trash button to delete. */
async function showHistory(chat: ChatService): Promise<void> {
  type Item = vscode.QuickPickItem & { id: string };
  const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete conversation' };
  const pick = vscode.window.createQuickPick<Item>();
  pick.placeholder = 'Search chat history';
  pick.matchOnDescription = true;
  const load = async () => {
    const items = await chat.history();
    pick.items = items.map((h) => ({
      id: h.id,
      label: h.title,
      description: `${h.messageCount} messages`,
      detail: new Date(h.updatedAt).toLocaleString(),
      iconPath: new vscode.ThemeIcon(h.id === chat.currentId ? 'comment-discussion' : 'comment'),
      buttons: [deleteButton],
    }));
    if (!items.length) pick.placeholder = 'No saved conversations yet';
  };
  pick.onDidAccept(async () => {
    const item = pick.selectedItems[0];
    pick.hide();
    if (item) {
      await chat.open(item.id);
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }
  });
  pick.onDidTriggerItemButton(async (e) => {
    await chat.delete(e.item.id);
    await load();
  });
  pick.onDidHide(() => pick.dispose());
  await load();
  pick.show();
}

export function deactivate(): void {
  /* disposables are cleaned up via context.subscriptions */
}
