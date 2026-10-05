import {
  BackendClient,
  type TokenProvider,
} from "@stella/contracts/backend/client";
import { EngineTokenRefresher } from "@stella/contracts/backend/engine-refresher";
import {
  DEVICE_AUTH_PROVIDERS,
  type EngineClientAccess,
  type EngineClientAccessResult,
  type DeviceAuthProvider,
  type EngineSettings,
} from "@stella/contracts/backend/engines";
import { loginAnthropic } from "@stella/runtime/ai/utils/oauth";
import { listenForChatGptCallback } from "@stella/runtime/ai/utils/oauth/chatgpt";

/**
 * The owner's Claude accounts, as this computer uses them. The list lives in
 * the owner's Stella account (`engines.get`), so an account added on any
 * device works here. This service holds the active account's short-lived
 * access token (`engines.clientAccess`), cached until shortly before it
 * expires, and hands it to the runtime through the credential broker:
 * Claude Code gets it as CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Claude sign-in and refresh run here, never on Stella's server:
 * `connectClaude` runs the loopback OAuth flow from this computer and uploads
 * the tokens, and while signed in the refresher keeps every Claude account
 * fresh, taking the account's refresh lease so only one device refreshes at
 * a time.
 *
 * ChatGPT on this computer has its own store (`chatgpt-profiles.ts`); here
 * only the owner's cloud is signed in to ChatGPT (`connectChatGptCloud`),
 * whose credentials stay on Stella's server.
 *
 * Signed out, offline before the first list, or with no account: no token,
 * and Claude Code keeps its own login.
 */

/** Refetch this long before a cached token expires. */
const EXPIRY_SKEW_MS = 60_000;
/** How long a token request waits for another device's Claude refresh to land. */
const PEER_REFRESH_WAIT_MS = 20_000;

type CachedAccess = Pick<EngineClientAccess, "accessToken" | "expiresAt" | "engineAccountId">;

export type EngineAccountAccessOptions = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  /** The connected providers changed; the runtime re-lists them. */
  onProvidersChanged: () => void;
};

const isDeviceAuthProvider = (value: string): value is DeviceAuthProvider =>
  (DEVICE_AUTH_PROVIDERS as readonly string[]).includes(value);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const tokenSubject = (token: string | null): string | null => {
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
  private settings: EngineSettings | null = null;
  private reportedProviders = "";
  private subject: string | null = null;
  private readonly tokens = new Map<DeviceAuthProvider, CachedAccess>();
  /** The account each provider's last token belonged to, for limit reports. */
  private readonly served = new Map<DeviceAuthProvider, string>();
  private readonly fetching = new Map<DeviceAuthProvider, Promise<string | null>>();
  /** Bumped on account change, so a fetch for the previous account is dropped. */
  private epoch = 0;
  private readonly refresher: EngineTokenRefresher;
  private claudeConnect: AbortController | null = null;
  private chatGptConnect: AbortController | null = null;

  constructor(private readonly options: EngineAccountAccessOptions) {
    this.refresher = new EngineTokenRefresher({
      client: () => (this.subject ? this.ensureClient() : null),
      log: (message) => console.warn(message),
    });
  }

  /** Whether `provider` is one this service serves instead of the local store. */
  static serves(provider: string): provider is DeviceAuthProvider {
    return isDeviceAuthProvider(provider);
  }

  /** Providers with at least one connected account; starts following the list. */
  providers(): DeviceAuthProvider[] {
    this.ensureWatch();
    return this.connectedProviders();
  }

  /**
   * The Stella session changed. A different account (or a sign-out) drops
   * everything held for the previous one and re-reads the list.
   */
  noteAuthToken(token: string | null): void {
    const next = tokenSubject(token);
    if (next === this.subject) return;
    this.subject = next;
    this.epoch += 1;
    this.tokens.clear();
    this.served.clear();
    this.fetching.clear();
    this.claudeConnect?.abort();
    this.chatGptConnect?.abort();
    this.applySettings(null);
    this.client?.value.reconnect();
    // Signed in: follow the account list, so Claude sign-ins stay fresh even
    // while nothing on this computer is using them.
    if (next) this.ensureWatch();
  }

  /**
   * Add a Claude account: the loopback OAuth flow runs on this computer (the
   * browser opens through `openUrl`), the code exchange and profile lookup
   * happen from here, and only then are the tokens uploaded to the owner's
   * Stella account. A second call cancels the first.
   */
  async connectClaude(openUrl: (url: string) => void): Promise<{ accountId: string }> {
    this.claudeConnect?.abort();
    const controller = new AbortController();
    this.claudeConnect = controller;
    try {
      const client = this.ensureClient();
      if (!client || !this.subject) throw new Error("Sign in to Stella first.");
      const credentials = await loginAnthropic({
        onAuth: ({ url }) => openUrl(url),
        onPrompt: async () => {
          throw new Error("Claude sign-in was canceled.");
        },
        signal: controller.signal,
      });
      const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
      const identity = text(credentials.identity);
      const email = text(credentials.email);
      const plan = text(credentials.plan);
      return await client.call("engines.addAccount", {
        provider: "anthropic",
        tokens: {
          access: credentials.access,
          refresh: credentials.refresh,
          expiresInMs: credentials.expires - Date.now(),
        },
        ...(identity ? { identity } : {}),
        ...(email ? { email } : {}),
        ...(plan ? { plan } : {}),
      });
    } finally {
      if (this.claudeConnect === controller) this.claudeConnect = null;
    }
  }

  /**
   * Sign the owner's cloud in to ChatGPT. The server builds the
   * authorization for the cloud's own host id; this computer only catches
   * the browser's 127.0.0.1 redirect on its loopback listener and hands the
   * URL back, and the server exchanges the code and keeps the credentials.
   * `accountId` signs a saved cloud account in again; `enablePlanUsage` asks
   * for consent again after plan usage was declined. A second call cancels
   * the first.
   */
  async connectChatGptCloud(
    openUrl: (url: string) => void,
    options: { accountId?: string; enablePlanUsage?: boolean } = {},
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

  /** Stop a Claude sign-in in progress; whether there was one. */
  cancelClaudeConnect(): boolean {
    const current = this.claudeConnect;
    current?.abort(new Error("Claude sign-in was canceled."));
    return Boolean(current);
  }

  async getAccessToken(
    provider: DeviceAuthProvider,
    options: { forceRefresh?: boolean } = {},
  ): Promise<string | null> {
    const cached = this.tokens.get(provider);
    if (!options.forceRefresh && cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }
    const pending = this.fetching.get(provider);
    if (pending) return await pending;
    const run = this.fetchAccessToken(provider, options.forceRefresh === true).finally(() => {
      if (this.fetching.get(provider) === run) this.fetching.delete(provider);
    });
    this.fetching.set(provider, run);
    return await run;
  }

  /**
   * The account last served for `provider` hit its usage limit. Resolves
   * whether another account now serves it (fetch a new token and retry).
   */
  async reportLimit(provider: DeviceAuthProvider, resetsAt?: number): Promise<{ switched: boolean }> {
    const engineAccountId = this.served.get(provider);
    const client = this.ensureClient();
    if (!engineAccountId || !client) return { switched: false };
    try {
      const result = await client.call("engines.reportLimit", {
        provider,
        engineAccountId,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
      if (result.switched) this.tokens.delete(provider);
      return result;
    } catch {
      return { switched: false };
    }
  }

  dispose(): void {
    this.claudeConnect?.abort();
    this.chatGptConnect?.abort();
    this.refresher.dispose();
    this.unwatch?.();
    this.unwatch = null;
    this.client?.value.dispose();
    this.client = null;
    this.tokens.clear();
  }

  private async fetchAccessToken(
    provider: DeviceAuthProvider,
    forceRefresh: boolean,
  ): Promise<string | null> {
    const client = this.ensureClient();
    if (!client) return null;
    const epoch = this.epoch;
    const rejected = forceRefresh ? this.tokens.get(provider)?.accessToken : undefined;
    const read = () => client.call("engines.clientAccess", { provider });
    let access: EngineClientAccessResult | null;
    try {
      access = await read();
      if (provider === "anthropic") {
        access = await this.refreshClaudeIfNeeded(access, read, forceRefresh, rejected);
      }
    } catch {
      // Offline or the backend is unavailable: a token that has not expired
      // still works against the provider.
      const cached = this.tokens.get(provider);
      return cached && cached.expiresAt > Date.now() ? cached.accessToken : null;
    }
    if (epoch !== this.epoch) return null;
    if (!access || access.status !== "ok") {
      this.tokens.delete(provider);
      return null;
    }
    this.tokens.set(provider, {
      accessToken: access.accessToken,
      expiresAt: access.expiresAt,
      engineAccountId: access.engineAccountId,
    });
    this.served.set(provider, access.engineAccountId);
    return access.accessToken;
  }

  /**
   * Claude's token as the server has it, refreshed on this device first when
   * it expired, or when Anthropic rejected it (`forced`; `rejected` is the
   * refused token, so a newer one another device stored is used as is).
   * While another device holds the refresh lease, waits briefly for its
   * result. A token merely due is served; the refresher renews it meanwhile.
   */
  private async refreshClaudeIfNeeded(
    first: EngineClientAccessResult | null,
    read: () => Promise<EngineClientAccessResult | null>,
    forced: boolean,
    rejected: string | undefined,
  ): Promise<EngineClientAccessResult | null> {
    const deadline = Date.now() + PEER_REFRESH_WAIT_MS;
    let access = first;
    let force = forced;
    for (;;) {
      if (!access) return null;
      const stale =
        access.status === "needs_device_refresh" ||
        (force && (rejected === undefined || access.accessToken === rejected));
      if (!stale) {
        if (access.status === "ok" && (access.refreshAt ?? 0) <= Date.now()) {
          void this.refresher.refreshNow("anthropic", access.engineAccountId);
        }
        return access;
      }
      const outcome = await this.refresher.refreshNow("anthropic", access.engineAccountId, {
        force,
      });
      force = false;
      if (outcome === "failed" || Date.now() >= deadline) return await read();
      if (outcome === "busy") await sleep(2_000);
      access = await read();
      if (outcome !== "busy") return access;
    }
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

  private connectedProviders(): DeviceAuthProvider[] {
    const connections = this.settings?.connections ?? [];
    return DEVICE_AUTH_PROVIDERS.filter((provider) =>
      connections.some((row) => row.provider === provider),
    );
  }

  private applySettings(settings: EngineSettings | null): void {
    this.settings = settings;
    this.refresher.update(settings);
    // A token for an account that no longer serves is dropped, so the next
    // request runs on the account now in use.
    for (const [provider, cached] of this.tokens) {
      const active = settings?.connections.find((row) => row.provider === provider && row.active);
      if (active?.accountId !== cached.engineAccountId) this.tokens.delete(provider);
    }
    const providers = this.connectedProviders().join(",");
    if (providers === this.reportedProviders) return;
    this.reportedProviders = providers;
    this.options.onProvidersChanged();
  }
}
