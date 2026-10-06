/**
 * Engine accounts: the owner's Claude (Pro/Max) and ChatGPT subscriptions,
 * plus the account-wide cloud execution selection every client picker reads
 * and writes.
 *
 * Claude: Stella never holds a Claude credential. Every place that runs
 * Claude (each of the owner's computers, and the owner's cloud container)
 * runs the real `claude` CLI on that CLI's own login. Signing in is always
 * the CLI's own `claude auth login`, against Anthropic's own page; the code
 * Anthropic shows is pasted back into that CLI. This list keeps only
 * identities (email, plan) and, per account, the places where a Claude Code
 * login for it exists (`places`). The active account is the one every place
 * uses when it has a login for it; nothing ever switches accounts on its own.
 *
 * - A computer reports the logins its Claude Code configs hold
 *   (`engines.reportClaudeLogins`), which adds their identities here.
 * - The cloud signs in inside the owner's container:
 *   `engines.startClaudeCloudLogin` starts `claude auth login` there and
 *   returns Anthropic's sign-in URL; `engines.finishClaudeCloudLogin` hands
 *   the code the user pasted to that CLI. The credential stays in the
 *   container's own disk state.
 *
 * ChatGPT follows Sign in with ChatGPT for open-source apps
 * (`@stella/contracts/chatgpt-siwc`). Every install is its own agent host
 * with its own ChatGPT sign-ins (kept on that computer, never here); the
 * owner's cloud is one more host, with its own persisted host id in this
 * store. One issued client id can be reused by every host of the same user
 * and workspace, each with its own host id, so the hosts share plan usage
 * settings and limits: hosts publish the issued client ids they registered
 * (`engines.shareChatGptRegistration`, identifiers only, never tokens) and
 * another host signs in with one of them instead of registering again.
 *
 * Each provider can hold several accounts; the user picks the active one.
 * A usage limit is reported to the user and never switches accounts.
 */

import type { CloudExecutionSelection } from "../agent-engine.js";

export const ENGINE_PROVIDERS = ["anthropic", "chatgpt"] as const;
export type EngineProvider = (typeof ENGINE_PROVIDERS)[number];

/** Where a Claude Code login for an account exists. */
export type ClaudeLoginPlace =
  | { kind: "cloud"; updatedAt: number }
  | { kind: "device"; deviceId: string; deviceName?: string; updatedAt: number };

/** One connected account of a provider. */
export type EngineConnection = {
  provider: EngineProvider;
  /** Stella's id for this account; stable across sign-ins of the same login. */
  accountId: string;
  label: string;
  /** The provider login's email, when the provider shares it. */
  email?: string;
  /** The subscription plan, when known (e.g. "max", "pro", "Plus"). */
  plan?: string;
  /** The account holder's name, when the provider shares it (ChatGPT). */
  name?: string;
  /**
   * ChatGPT only (the cloud's sign-in). Absent while signed in; `signed_out`
   * keeps the registration (issued client id) for a later sign-in;
   * `reauth_required` means its tokens stopped working and it must sign in
   * again.
   */
  status?: "signed_out" | "reauth_required";
  /** ChatGPT only: false when the sign-in didn't grant ChatGPT plan usage. */
  planUsage?: boolean;
  /** ChatGPT only: the registration's issued client id (an identifier, not a credential). */
  clientId?: string;
  /** The account every place uses for this provider when it has a login for it. */
  active: boolean;
  /** Claude only: the places that hold a Claude Code login for this account. */
  places?: ClaudeLoginPlace[];
  updatedAt: number;
};

/**
 * A ChatGPT registration one of the owner's hosts made: the issued client id
 * (an identifier, not a credential) and who it belongs to. Another host signs
 * in with it under its own host id.
 */
export type ChatGptSharedRegistration = {
  clientId: string;
  email?: string;
  name?: string;
  updatedAt: number;
};

export type EngineSettings = {
  /** The saved selection, whether or not its engine is still connected. */
  execution: CloudExecutionSelection;
  /** When the account last saved a selection; null until the first save. */
  selectedAt: number | null;
  /** Every connected account, grouped by provider in connection order. */
  connections: EngineConnection[];
  /** ChatGPT registrations the owner's hosts made, newest first. */
  chatGptRegistrations: ChatGptSharedRegistration[];
};

/** Whether an account can serve the cloud's turns. */
export const isEngineConnectionUsable = (connection: EngineConnection): boolean =>
  connection.provider === "anthropic"
    ? (connection.places ?? []).some((place) => place.kind === "cloud")
    : !connection.status && connection.planUsage !== false;

/** One login a computer's Claude Code configs hold (identity only). */
export type ClaudeLocalLogin = { email: string; plan?: string };

export type EngineCalls = {
  "engines.cancelConnect": {
    args: { connectId: string };
    result: null;
  };
  /**
   * Start signing the owner's cloud in to ChatGPT. `redirectPort`: the
   * caller's loopback listener (desktop); without it the redirect goes to
   * the documented default port and the user pastes the URL it lands on.
   * `accountId` signs a saved cloud account in again; `clientId` reuses a
   * registration another host of the owner made (`chatGptRegistrations`)
   * instead of registering a new one; `enablePlanUsage` asks for consent
   * again after plan usage was declined.
   */
  "engines.startConnect": {
    args: {
      provider: "chatgpt";
      redirectPort?: number;
      accountId?: string;
      clientId?: string;
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
   * A host registered (or signed in with) a ChatGPT client: record its issued
   * client id so the owner's other hosts can reuse it. Never tokens.
   */
  "engines.shareChatGptRegistration": {
    args: { clientId: string; email?: string; name?: string };
    result: null;
  };
  /**
   * A computer's current Claude Code logins (identities only). Adds unknown
   * identities as accounts and replaces this device's places.
   */
  "engines.reportClaudeLogins": {
    args: { deviceId: string; deviceName?: string; logins: ClaudeLocalLogin[] };
    result: null;
  };
  /**
   * Start `claude auth login` in the owner's cloud container and return
   * Anthropic's sign-in URL. `email` pre-fills the login page.
   */
  "engines.startClaudeCloudLogin": {
    args: { email?: string };
    result: { loginId: string; authorizeUrl: string };
  };
  /**
   * Hand the code Anthropic showed to the cloud's waiting CLI. A wrong code
   * fails with the CLI's own error.
   */
  "engines.finishClaudeCloudLogin": {
    args: { loginId: string; code: string };
    result: { accountId: string; email: string };
  };
  "engines.cancelClaudeCloudLogin": {
    args: { loginId: string };
    result: null;
  };
  /** `claude auth logout` for this account in the cloud container. */
  "engines.signOutClaudeCloud": {
    args: { accountId: string };
    result: null;
  };
  /**
   * Remove one account (or, without `accountId`, every account of the
   * provider). Claude: forgets the identity and signs the cloud out of it;
   * computers keep their own Claude Code logins. Falls back to the managed
   * engine when the provider's last usable account goes while it was
   * selected. ChatGPT: the session is revoked and its registration kept for
   * a later sign-in unless `forget`; `revoked` is false when the revocation
   * couldn't be confirmed (the user can disconnect Stella in ChatGPT
   * Settings).
   */
  "engines.disconnect": {
    args: { provider: EngineProvider; accountId?: string; forget?: boolean };
    result: { revoked: boolean } | null;
  };
  /** Make one account the one every place uses. */
  "engines.setActiveAccount": {
    args: { provider: EngineProvider; accountId: string };
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
   * The models the cloud's active ChatGPT account may use (`GET /v1/models`),
   * for the cloud picker; null when no usable account is signed in.
   */
  "engines.listModels": {
    args: { provider: "chatgpt" };
    result: { models: Array<{ id: string; name: string }> } | null;
  };
};

export type EngineViews = {
  "engines.get": { args: Record<string, never>; result: EngineSettings };
};
