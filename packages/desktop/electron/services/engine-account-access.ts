import {
  BackendClient,
  type TokenProvider,
} from "@stella/contracts/backend/client";
import type {
  ClaudeLocalLogin,
  EngineConnection,
  EngineSettings,
} from "@stella/contracts/backend/engines";
import { listenForChatGptCallback } from "@stella/runtime/kernel/integrations/chatgpt-sign-in";

/**
 * The owner's engine accounts as this computer sees them: the list in the
 * owner's Stella account (`engines.get`), followed while signed in, and the
 * few calls this computer makes about them. It holds no credential.
 *
 * - Claude: this computer reports which Claude Code logins it holds
 *   (identities only, `reportClaudeLogins`); `ClaudeLocalAccounts` picks the
 *   login for the active account from `settings()`.
 * - ChatGPT: this computer's own accounts live in `chatgpt-profiles.ts`;
 *   here it publishes the issued client ids it registered
 *   (`shareChatGptRegistration`) and signs the owner's cloud in
 *   (`connectChatGptCloud`), whose credentials stay on Stella's server.
 */

export type EngineAccountAccessOptions = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
};

/** The account a Stella session token is for (its `sub`). */
export const tokenSubject = (token: string | null): string | null => {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
};

export class EngineAccountAccess {
  private client: { baseUrl: string; value: BackendClient } | null = null;
  private unwatch: (() => void) | null = null;
  private current: EngineSettings | null = null;
  private subject: string | null = null;
  private chatGptConnect: AbortController | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: EngineAccountAccessOptions) {}

  /**
   * The Stella session changed. A different account (or a sign-out) drops
   * the list held for the previous one and re-reads it.
   */
  noteAuthToken(token: string | null): void {
    const next = tokenSubject(token);
    if (next === this.subject) return;
    this.subject = next;
    this.chatGptConnect?.abort();
    this.applySettings(null);
    this.client?.value.reconnect();
    if (next) this.ensureWatch();
  }

  /** Signed in to Stella (the session's subject), whether or not the list arrived. */
  isSignedIn(): boolean {
    return this.subject !== null;
  }

  /** The owner's engine settings; null while signed out or before the first read. */
  settings(): EngineSettings | null {
    if (this.subject) this.ensureWatch();
    return this.current;
  }

  /** The owner's active Claude account, if one is chosen. */
  activeClaudeAccount(): EngineConnection | null {
    return (
      this.settings()?.connections.find(
        (connection) => connection.provider === "anthropic" && connection.active,
      ) ?? null
    );
  }

  /** Called when the settings change (including to null); returns an unsubscribe. */
  onSettingsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Record this computer's Claude Code logins (identities only). */
  async reportClaudeLogins(args: {
    deviceId: string;
    deviceName?: string;
    logins: ClaudeLocalLogin[];
  }): Promise<void> {
    const client = this.ensureClient();
    if (!client || !this.subject) throw new Error("Sign in to Stella first.");
    await client.call("engines.reportClaudeLogins", args);
  }

  /** A shared ChatGPT registration's identity hints, when another host published it. */
  chatGptRegistration(clientId: string): { email?: string; name?: string } | null {
    const row = this.settings()?.chatGptRegistrations?.find((entry) => entry.clientId === clientId);
    if (!row) return null;
    return {
      ...(row.email ? { email: row.email } : {}),
      ...(row.name ? { name: row.name } : {}),
    };
  }

  /**
   * Publish an issued ChatGPT client id this computer signed in with, so the
   * owner's other hosts can reuse it. Identifiers only; best effort.
   */
  async shareChatGptRegistration(args: {
    clientId: string;
    email?: string;
    name?: string;
  }): Promise<void> {
    const client = this.ensureClient();
    if (!client || !this.subject) return;
    try {
      await client.call("engines.shareChatGptRegistration", {
        clientId: args.clientId,
        ...(args.email ? { email: args.email } : {}),
        ...(args.name ? { name: args.name } : {}),
      });
    } catch (error) {
      console.warn(
        `[engines] sharing the ChatGPT registration failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Sign the owner's cloud in to ChatGPT. The server builds the
   * authorization for the cloud's own host id; this computer only catches
   * the browser's 127.0.0.1 redirect on its loopback listener and hands the
   * URL back, and the server exchanges the code and keeps the credentials.
   * `accountId` signs a saved cloud account in again; `clientId` reuses a
   * registration another host of the owner made; `enablePlanUsage` asks for
   * consent again after plan usage was declined. A second call cancels the
   * first.
   */
  async connectChatGptCloud(
    openUrl: (url: string) => void,
    options: { accountId?: string; clientId?: string; enablePlanUsage?: boolean } = {},
  ): Promise<{ accountId: string; planUsage: boolean }> {
    this.chatGptConnect?.abort();
    const controller = new AbortController();
    this.chatGptConnect = controller;
    const client = this.ensureClient();
    if (!client || !this.subject) throw new Error("Sign in to Stella first.");
    const listener = await listenForChatGptCallback({ signal: controller.signal });
    let connectId: string | null = null;
    try {
      const started = await client.call("engines.startConnect", {
        provider: "chatgpt",
        redirectPort: listener.port,
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.clientId ? { clientId: options.clientId } : {}),
        ...(options.enablePlanUsage ? { enablePlanUsage: true } : {}),
      });
      connectId = started.connectId;
      const state = new URL(started.authorizeUrl).searchParams.get("state");
      if (!state || started.redirectUri !== listener.redirectUri) {
        throw new Error("ChatGPT sign-in couldn't start. Try again.");
      }
      openUrl(started.authorizeUrl);
      const callbackUrl = await listener.waitForCallback(state);
      const result = await client.call("engines.finishConnect", {
        connectId,
        pastedInput: callbackUrl,
      });
      connectId = null;
      return result;
    } finally {
      listener.close();
      const unfinished = connectId;
      if (unfinished) {
        client.call("engines.cancelConnect", { connectId: unfinished }).catch(() => undefined);
      }
      if (this.chatGptConnect === controller) this.chatGptConnect = null;
    }
  }

  /** Stop a cloud ChatGPT sign-in in progress; whether there was one. */
  cancelChatGptCloudConnect(): boolean {
    const current = this.chatGptConnect;
    current?.abort();
    return Boolean(current);
  }

  dispose(): void {
    this.chatGptConnect?.abort();
    this.unwatch?.();
    this.unwatch = null;
    this.client?.value.dispose();
    this.client = null;
    this.listeners.clear();
  }

  private ensureClient(): BackendClient | null {
    const baseUrl = this.options.getBackendUrl();
    if (!baseUrl) return null;
    if (this.client?.baseUrl === baseUrl) return this.client.value;
    this.unwatch?.();
    this.unwatch = null;
    this.client?.value.dispose();
    const getToken: TokenProvider = async () => await this.options.getAuthToken();
    this.client = { baseUrl, value: new BackendClient({ baseUrl, getToken }) };
    return this.client.value;
  }

  private ensureWatch(): void {
    const client = this.ensureClient();
    if (!client || this.unwatch) return;
    this.unwatch = client.watch(
      "engines.get",
      {},
      (value) => this.applySettings(value),
      // Signed out or refused: no accounts until the session changes.
      () => this.applySettings(null),
    );
  }

  private applySettings(settings: EngineSettings | null): void {
    if (settings === null && this.current === null) return;
    this.current = settings;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn("[engines] settings listener failed:", error);
      }
    }
  }
}
