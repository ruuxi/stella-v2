export const AUTH_HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;

export type BrowserAuthHandoffResult = "none" | "redeemed" | "failed";

export type AutomaticAnonymousBootstrapDecision =
  | "create_anonymous"
  | "session_exists"
  | "handoff_failed";

type BrowserHandoffLocation = Pick<Location, "hash" | "pathname" | "search">;

type BrowserHandoffHistory = Pick<History, "replaceState" | "state">;

/**
 * Consume a browser auth credential from the URL fragment.
 *
 * Fragments are not included in the request to the renderer host. Erase the
 * entire fragment before returning the token so it cannot survive in copied
 * URLs, screenshots, subsequent navigation, or client-side diagnostics.
 */
export const consumeBrowserAuthHandoffToken = (
  location: BrowserHandoffLocation,
  history: BrowserHandoffHistory,
): string | null => {
  const rawFragment = location.hash.replace(/^#\??/, "");
  if (!rawFragment) {
    return null;
  }

  const params = new URLSearchParams(rawFragment);
  if (!params.has("ott")) {
    return null;
  }

  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}`,
  );

  const tokens = params.getAll("ott");
  if (tokens.length !== 1) {
    return null;
  }

  const token = tokens[0] ?? "";
  return AUTH_HANDOFF_TOKEN_PATTERN.test(token) ? token : null;
};

/**
 * Keep automatic anonymous auth behind the browser handoff barrier. Reading
 * the session only after that promise settles makes the decision independent
 * of React effect order or network timing.
 */
export const decideAutomaticAnonymousBootstrap = async (
  handoff: Promise<BrowserAuthHandoffResult>,
  hasSession: () => boolean,
): Promise<AutomaticAnonymousBootstrapDecision> => {
  const result = await handoff;
  if (result === "failed") {
    return "handoff_failed";
  }
  return hasSession() ? "session_exists" : "create_anonymous";
};
