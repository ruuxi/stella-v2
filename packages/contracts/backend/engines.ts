/**
 * Engine accounts: the owner's one list of Claude (Pro/Max) and ChatGPT
 * subscriptions, used by every client (Claude Code and Codex on the owner's
 * computers, and cloud turns), plus the account-wide cloud execution
 * selection every client picker reads and writes.
 *
 * ChatGPT sign-in uses device authorization and automatic polling.
 * `startConnect` / `finishConnect` are the pasted-code flow for Claude.
 * Tokens are exchanged and stored encrypted in the owner's object, which is
 * the only party that refreshes them: refresh tokens never leave the server.
 * A signed-in client asks `engines.clientAccess` for the active account's
 * short-lived access token and talks to the provider directly.
 *
 * Each provider can hold several accounts. One is active and serves every
 * turn; with auto-switch on, an account that hits its subscription limit is
 * put on cooldown until the limit resets and the next available account takes
 * over.
 */

import type { CloudExecutionSelection } from "../agent-engine.js";

export const ENGINE_PROVIDERS = ["anthropic", "openai-codex"] as const;
export type EngineProvider = (typeof ENGINE_PROVIDERS)[number];

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
  /** The account that serves this provider's turns. */
  active: boolean;
  /** Set while the account's subscription limit is exhausted: when it resets. */
  limitedUntil?: number;
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

/** The active account's short-lived access token, for the owner's own clients. */
export type EngineClientAccess = {
  accessToken: string;
  /** Epoch ms; refetch before this. */
  expiresAt: number;
  /** The connected account (`EngineConnection.accountId`) the token belongs to. */
  engineAccountId: string;
  /** ChatGPT only: the chatgpt_account_id the Codex backend expects. */
  accountId?: string;
};

export type EngineCalls = {
  /** Mobile-safe ChatGPT login; no loopback callback or pasted URL. */
  "engines.startDeviceConnect": {
    args: Record<string, never>;
    result: { connectId: string; authorizeUrl: string; userCode: string; intervalMs: number };
  };
  "engines.pollDeviceConnect": {
    args: { connectId: string };
    result: { status: "pending" | "connected" };
  };
  "engines.cancelConnect": {
    args: { connectId: string };
    result: null;
  };
  "engines.startConnect": {
    args: { provider: EngineProvider };
    result: { connectId: string; authorizeUrl: string };
  };
  "engines.finishConnect": {
    args: { connectId: string; pastedInput: string };
    result: { ok: true };
  };
  /**
   * Sign one account out (or, without `accountId`, every account of the
   * provider). Falls back to the managed engine when the provider's last
   * account goes while it was selected.
   */
  "engines.disconnect": {
    args: { provider: EngineProvider; accountId?: string };
    result: null;
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
   * The provider's serving account's access token (refreshed on the server
   * when it is close to expiry), or null when no account is connected or its
   * refresh failed. `forceRefresh`: the provider rejected the last token.
   */
  "engines.clientAccess": {
    args: { provider: EngineProvider; forceRefresh?: boolean };
    result: EngineClientAccess | null;
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
