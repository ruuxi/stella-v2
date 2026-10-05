import {
  BackendClient,
  type TokenProvider,
} from "@stella/contracts/backend/client";
import {
  ENGINE_PROVIDERS,
  type EngineClientAccess,
  type EngineProvider,
  type EngineSettings,
} from "@stella/contracts/backend/engines";

/**
 * The owner's Claude and ChatGPT accounts, as this computer uses them. The
 * list lives in the owner's Stella account (`engines.get`), so an account
 * added on any device works here. The server keeps the refresh tokens and is
 * the only party that refreshes; this service only ever holds the active
 * account's short-lived access token (`engines.clientAccess`), cached until
 * shortly before it expires, and hands it to the runtime through the
 * credential broker: Claude Code gets it as CLAUDE_CODE_OAUTH_TOKEN, Codex
 * runs on Stella's harness with it.
 *
 * Signed out, offline before the first list, or with no account: no token,
 * and Claude Code keeps its own login.
 */

/** Refetch this long before a cached token expires. */
const EXPIRY_SKEW_MS = 60_000;

type CachedAccess = Pick<EngineClientAccess, "accessToken" | "expiresAt" | "engineAccountId">;

export type EngineAccountAccessOptions = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  /** The connected providers changed; the runtime re-lists them. */
  onProvidersChanged: () => void;
};

const isEngineProvider = (value: string): value is EngineProvider =>
  (ENGINE_PROVIDERS as readonly string[]).includes(value);

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
  private readonly tokens = new Map<EngineProvider, CachedAccess>();
  /** The account each provider's last token belonged to, for limit reports. */
  private readonly served = new Map<EngineProvider, string>();
  private readonly fetching = new Map<EngineProvider, Promise<string | null>>();
  /** Bumped on account change, so a fetch for the previous account is dropped. */
  private epoch = 0;

  constructor(private readonly options: EngineAccountAccessOptions) {}

  /** Whether `provider` is one this service serves instead of the local store. */
  static serves(provider: string): provider is EngineProvider {
    return isEngineProvider(provider);
  }

  /** Providers with at least one connected account; starts following the list. */
  providers(): EngineProvider[] {
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
    this.applySettings(null);
    this.client?.value.reconnect();
  }

  async getAccessToken(
    provider: EngineProvider,
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
  async reportLimit(provider: EngineProvider, resetsAt?: number): Promise<{ switched: boolean }> {
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
    this.unwatch?.();
    this.unwatch = null;
    this.client?.value.dispose();
    this.client = null;
    this.tokens.clear();
  }

  private async fetchAccessToken(
    provider: EngineProvider,
    forceRefresh: boolean,
  ): Promise<string | null> {
    const client = this.ensureClient();
    if (!client) return null;
    const epoch = this.epoch;
    let access: EngineClientAccess | null;
    try {
      access = await client.call("engines.clientAccess", {
        provider,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
    } catch {
      // Offline or the backend is unavailable: a token that has not expired
      // still works against the provider.
      const cached = this.tokens.get(provider);
      return cached && cached.expiresAt > Date.now() ? cached.accessToken : null;
    }
    if (epoch !== this.epoch) return null;
    if (!access) {
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

  private connectedProviders(): EngineProvider[] {
    const connections = this.settings?.connections ?? [];
    return ENGINE_PROVIDERS.filter((provider) =>
      connections.some((row) => row.provider === provider),
    );
  }

  private applySettings(settings: EngineSettings | null): void {
    this.settings = settings;
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
