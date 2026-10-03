import type * as vscode from 'vscode';

/** API key values live only in VS Code SecretStorage (OS keychain). Never in settings, globalState or logs. */
export class KeyVault {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private slot(providerId: string, keyId: string): string {
    return `codeweave.apiKey.${providerId}.${keyId}`;
  }

  get(providerId: string, keyId: string): Thenable<string | undefined> {
    return this.secrets.get(this.slot(providerId, keyId));
  }

  set(providerId: string, keyId: string, value: string): Thenable<void> {
    return this.secrets.store(this.slot(providerId, keyId), value);
  }

  delete(providerId: string, keyId: string): Thenable<void> {
    return this.secrets.delete(this.slot(providerId, keyId));
  }

  static mask(value: string): string {
    const v = value.trim();
    if (v.length <= 8) return '••••';
    return `${v.slice(0, 3)}…${v.slice(-4)}`;
  }
}
