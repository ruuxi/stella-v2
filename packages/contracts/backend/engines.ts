/**
 * Cloud engines: the owner's connected subscriptions (Claude Pro/Max,
 * ChatGPT) and the account-wide execution selection every client picker
 * reads and writes.
 *
 * Connecting is paste-based so it works from any browser: `startConnect`
 * returns the provider's authorize URL, and the user pastes the code (Claude)
 * or the full localhost redirect URL (ChatGPT) into `finishConnect`. Tokens
 * are exchanged and stored encrypted in the owner's object; no client ever
 * sees them.
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

export type EngineCalls = {
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
};

export type EngineViews = {
  "engines.get": { args: Record<string, never>; result: EngineSettings };
};
