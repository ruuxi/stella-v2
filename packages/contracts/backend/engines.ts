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
 */

import type { CloudExecutionSelection } from "../agent-engine.js";

export const ENGINE_PROVIDERS = ["anthropic", "openai-codex"] as const;
export type EngineProvider = (typeof ENGINE_PROVIDERS)[number];

export type EngineConnection = {
  provider: EngineProvider;
  label: string;
  updatedAt: number;
};

export type EngineSettings = {
  /** The saved selection, whether or not its engine is still connected. */
  execution: CloudExecutionSelection;
  /** When the account last saved a selection; null until the first save. */
  selectedAt: number | null;
  connections: EngineConnection[];
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
  /** Falls back to the managed engine when the disconnected one was selected. */
  "engines.disconnect": { args: { provider: EngineProvider }; result: null };
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
