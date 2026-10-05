/**
 * Engine accounts: the owner's Claude (Pro/Max) subscriptions, used by every
 * client (Claude Code on the owner's computers, and cloud turns), the
 * ChatGPT accounts signed in for the owner's cloud, plus the account-wide
 * cloud execution selection every client picker reads and writes.
 *
 * Claude (`DEVICE_AUTH_PROVIDERS`): every Anthropic auth call happens on one
 * of the owner's own devices, from their own network: the sign-in exchange
 * and profile lookup (then `engines.addAccount` uploads the tokens) and every
 * refresh. The server stores the tokens encrypted and never contacts
 * Anthropic's auth endpoints. Refresh tokens rotate, so exactly one device
 * refreshes an account at a time: it takes the account's refresh lease
 * (`engines.beginRefresh`, the only call that returns a refresh token),
 * refreshes with Anthropic, and uploads the result
 * (`engines.completeRefresh`), which the server accepts only from the lease
 * holder and only while the stored tokens are still the ones it handed out.
 * Devices refresh proactively from an account's `refreshAt`; past
 * `expiresAt` the cloud cannot use the account until one of them does.
 *
 * ChatGPT follows Sign in with ChatGPT for open-source apps
 * (`@stella/contracts/chatgpt-siwc`). Every install is its own agent host
 * with its own ChatGPT sign-ins (kept on that computer, never here); the
 * owner's cloud is one more host, with its own persisted host id in this
 * store. A client signs the cloud in: `engines.startConnect` builds the
 * authorization (cloud host id, fresh state/nonce/PKCE, a 127.0.0.1 loopback
 * redirect), the user approves in a browser, and the client hands the
 * redirect URL back to `engines.finishConnect` (desktop catches it on its
 * loopback listener; a browser or phone, where nothing listens, pastes it).
 * The server, as the host that will own the credentials, exchanges the code,
 * validates the ID token, stores the registration and tokens encrypted, and
 * owns every later refresh. ChatGPT tokens never leave the server.
 *
 * A signed-in client asks `engines.clientAccess` for the active Claude
 * account's short-lived access token and talks to Anthropic directly.
 *
 * Each provider can hold several accounts. One is active and serves every
 * turn; with auto-switch on, an account that hits its subscription limit is
 * put on cooldown until the limit resets and the next available account takes
 * over.
 */

import type { CloudExecutionSelection } from "../agent-engine.js";

export const ENGINE_PROVIDERS = ["anthropic", "chatgpt"] as const;
export type EngineProvider = (typeof ENGINE_PROVIDERS)[number];

/** Providers whose sign-in and refresh run only on the owner's devices. */
export const DEVICE_AUTH_PROVIDERS = ["anthropic"] as const;
export type DeviceAuthProvider = (typeof DEVICE_AUTH_PROVIDERS)[number];

/** One connected account of a provider. */
export type EngineConnection = {
  provider: EngineProvider;
  /** Stella's id for this account; stable across reconnects of the same login. */
  accountId: string;
  label: string;
  /** The provider login's email, when the provider shares it. */
  email?: string;
  /** The subscription plan, when known (e.g. "Max", "Pro", "Plus"). */
  plan?: string;
  /** The account holder's name, when the provider shares it (ChatGPT). */
  name?: string;
  /**
   * ChatGPT only. Absent while signed in; `signed_out` keeps the
   * registration (issued client id) for a later sign-in; `reauth_required`
   * means its tokens stopped working and it must sign in again.
   */
  status?: "signed_out" | "reauth_required";
  /** ChatGPT only: false when the sign-in didn't grant ChatGPT plan usage. */
  planUsage?: boolean;
  /** The account that serves this provider's turns. */
  active: boolean;
  /** Set while the account's subscription limit is exhausted: when it resets. */
  limitedUntil?: number;
  /**
   * Device-refreshed providers only. Server clock, epoch ms: when a signed-in
   * device should refresh this account's tokens (half their lifetime in), and
   * when the access token stops working. 0 when unknown, which is due now.
   */
  refreshAt?: number;
  expiresAt?: number;
  updatedAt: number;
};

export type EngineSettings = {
  /** The saved selection, whether or not its engine is still connected. */
  execution: CloudExecutionSelection;
  /** When the account last saved a selection; null until the first save. */
  selectedAt: number | null;
  /** Every connected account, grouped by provider in connection order. */
  connections: EngineConnection[];
  /** Per provider: switch to the next account when the active one hits its limit. */
  autoSwitch: Record<EngineProvider, boolean>;
};

/** Whether an account can serve turns: signed in, with plan usage granted. */
export const isEngineConnectionUsable = (connection: EngineConnection): boolean =>
  !connection.status && connection.planUsage !== false;

/** The active Claude account's short-lived access token, for the owner's own clients. */
export type EngineClientAccess = {
  accessToken: string;
  /** Epoch ms (server clock); refetch before this. */
  expiresAt: number;
  /** Device-refreshed providers: epoch ms (server clock) from which to refresh. */
  refreshAt?: number;
  /** The connected account (`EngineConnection.accountId`) the token belongs to. */
  engineAccountId: string;
};

/**
 * `engines.clientAccess`: the token, or word that the stored one has expired
 * and this device should refresh the account (take its lease) first.
 */
export type EngineClientAccessResult =
  | ({ status: "ok" } & EngineClientAccess)
  | { status: "needs_device_refresh"; engineAccountId: string };

/** Tokens a device obtained from the provider, as it uploads them. */
export type EngineTokenUpload = {
  access: string;
  refresh: string;
  /**
   * How long `access` stays valid, in ms, as the provider said. Relative, so
   * the server dates it on its own clock.
   */
  expiresInMs: number;
};

export type EngineCalls = {
  "engines.cancelConnect": {
    args: { connectId: string };
    result: null;
  };
  /**
   * Start signing the owner's cloud in to ChatGPT. `redirectPort`: the
   * caller's loopback listener (desktop); without it the redirect goes to
   * the documented default port and the user pastes the URL it lands on.
   * `accountId` signs a saved cloud account in again (its issued client id
   * and identity hints) instead of registering a new one;
   * `enablePlanUsage` asks for consent again after plan usage was declined.
   */
  "engines.startConnect": {
    args: {
      provider: "chatgpt";
      redirectPort?: number;
      accountId?: string;
      enablePlanUsage?: boolean;
    };
    result: { connectId: string; authorizeUrl: string; redirectUri: string };
  };
  /** The redirect URL (or its query) the browser landed on. */
  "engines.finishConnect": {
    args: { connectId: string; pastedInput: string };
    result: { accountId: string; planUsage: boolean };
  };
  /**
   * Store an account a device just signed in to. The same provider login
   * (`identity`) signing in again replaces its own account; a new login is
   * added. Either way it becomes the provider's active account.
   */
  "engines.addAccount": {
    args: {
      provider: DeviceAuthProvider;
      tokens: EngineTokenUpload;
      identity?: string;
      email?: string;
      plan?: string;
    };
    result: { accountId: string };
  };
  /**
   * Sign one account out (or, without `accountId`, every account of the
   * provider). Falls back to the managed engine when the provider's last
   * usable account goes while it was selected. ChatGPT: the session is
   * revoked and its registration kept for a later sign-in unless `forget`;
   * `revoked` is false when the revocation couldn't be confirmed (the user
   * can disconnect Stella in ChatGPT Settings).
   */
  "engines.disconnect": {
    args: { provider: EngineProvider; accountId?: string; forget?: boolean };
    result: { revoked: boolean } | null;
  };
  /** Make one connected account serve the provider's turns. */
  "engines.setActiveAccount": {
    args: { provider: EngineProvider; accountId: string };
    result: null;
  };
  "engines.setAutoSwitch": {
    args: { provider: EngineProvider; enabled: boolean };
    result: null;
  };
  /**
   * Save the account-wide selection. Not checked against connections: a
   * paired computer runs Claude Code or Codex on its own login, and cloud
   * turns fall back to the managed engine when the credential is missing.
   */
  "engines.setExecution": {
    args: { execution: CloudExecutionSelection };
    result: null;
  };
  /**
   * The serving Claude account's access token, or null when none is
   * connected; `needs_device_refresh` once it expired (this device takes the
   * refresh lease). The cloud's ChatGPT tokens are never handed out.
   */
  "engines.clientAccess": {
    args: { provider: DeviceAuthProvider };
    result: EngineClientAccessResult | null;
  };
  /**
   * The models the cloud's active ChatGPT account may use (`GET /v1/models`),
   * for the cloud picker; null when no usable account is signed in.
   */
  "engines.listModels": {
    args: { provider: "chatgpt" };
    result: { models: Array<{ id: string; name: string }> } | null;
  };
  /**
   * Ask for an account's refresh lease. `granted` hands this device the
   * refresh token, alone, until `leaseExpiresAt`; `fresh` means the account
   * is not due (another device refreshed it; ask again after `retryInMs`);
   * `busy` means another device holds the lease. `force`: the provider
   * rejected the current access token before it was due.
   */
  "engines.beginRefresh": {
    args: { provider: DeviceAuthProvider; engineAccountId: string; force?: boolean };
    result:
      | { status: "granted"; leaseId: string; refreshToken: string; leaseExpiresAt: number }
      | { status: "fresh"; retryInMs: number }
      | { status: "busy"; retryInMs: number };
  };
  /**
   * Upload the refreshed tokens. Refused (CONFLICT) unless `leaseId` is the
   * account's current lease and its stored tokens are still the ones handed
   * out with it.
   */
  "engines.completeRefresh": {
    args: {
      provider: DeviceAuthProvider;
      engineAccountId: string;
      leaseId: string;
      tokens: EngineTokenUpload;
    };
    result: { ok: true };
  };
  /** The refresh failed: release the lease so another attempt can start. */
  "engines.abandonRefresh": {
    args: { provider: DeviceAuthProvider; engineAccountId: string; leaseId: string };
    result: null;
  };
  /**
   * The account a client was served hit its subscription limit. It cools down
   * until `resetsAt` (or an hour); with auto-switch on, the next available
   * account takes over. `switched`: fetch a new token and retry.
   */
  "engines.reportLimit": {
    args: { provider: EngineProvider; engineAccountId: string; resetsAt?: number };
    result: { switched: boolean };
  };
};

export type EngineViews = {
  "engines.get": { args: Record<string, never>; result: EngineSettings };
};
