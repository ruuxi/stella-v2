/**
 * What a Sign in with ChatGPT host shows about its saved accounts (no
 * secrets). Types only, so the preload bridge and the renderer can import
 * them without the protocol module.
 */

/** One saved ChatGPT account on a host, as settings list it (no secrets). */
export type ChatGptProfileSummary = {
  id: string;
  label: string;
  email?: string;
  name?: string;
  /** Serves this host's ChatGPT turns. */
  active: boolean;
  /** `signed_out`: the registration is kept for a later sign-in. */
  status: "signed_in" | "signed_out" | "reauth_required";
  /** ChatGPT plan usage was granted. */
  planUsage: boolean;
  /** Set while the account's usage limit applies: when to try it again. */
  limitedUntil?: number;
  updatedAt: number;
};

export type ChatGptProfilesState = {
  /** Switch to the next signed-in account when the active one hits a limit. */
  autoSwitch: boolean;
  profiles: ChatGptProfileSummary[];
};
