/**
 * The runtime's connection to the Stella backend worker: backend calls and
 * live views over the shared `@stella/contracts/backend` client, authorized
 * with the same token the host hands every other cloud request.
 *
 * The client is rebuilt when the backend URL changes and reconnects when the
 * signed-in account does, so a view never carries one account's data into
 * another's session.
 */

import {
  BackendClient,
  backendTokenExpiryMs,
} from "@stella/contracts/backend/client";
import type { OwnerIdentity } from "@stella/contracts/backend/conversations";

type BackendSessionState = {
  backendUrl: string | null;
  authToken: string | null;
};

const sanitizeBackendUrl = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
};

const tokenSubject = (token: string | null): string | null => {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { sub?: unknown };
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
};

export type BackendSession = ReturnType<typeof createBackendSession>;

/**
 * `mintToken` is how a forced refresh reaches the host. The kernel only holds
 * the token the host pushed, so without it a forced call would hand back that
 * same token and the server's reauthentication could never complete.
 */
export const createBackendSession = (
  getState: () => BackendSessionState,
  mintToken?: () => Promise<string | null>,
) => {
  let client: BackendClient | null = null;
  let clientUrl: string | null = null;
  let subject: string | null = null;
  let identity: { subject: string | null; value: Promise<OwnerIdentity> } | null = null;
  let forcing: Promise<string> | null = null;

  const cachedToken = (): string | null => getState().authToken?.trim() || null;

  const mintNewerToken = async (): Promise<string> => {
    const previous = cachedToken();
    const previousExpiry = backendTokenExpiryMs(previous);
    const minted = (await mintToken?.())?.trim() || null;
    const next = minted ?? cachedToken();
    const nextExpiry = backendTokenExpiryMs(next);
    const isNewer =
      next !== null &&
      next !== previous &&
      (previousExpiry === null || nextExpiry === null || nextExpiry > previousExpiry);
    if (!isNewer) {
      throw new Error("Stella could not mint a newer cloud token.");
    }
    return next;
  };

  /**
   * A forced refresh resolves only with a token newer than the cached one, so
   * no caller can re-present the token that asked for the refresh.
   */
  const forceToken = async (): Promise<string> => {
    if (forcing) return await forcing;
    const attempt = mintNewerToken();
    forcing = attempt;
    try {
      return await attempt;
    } finally {
      if (forcing === attempt) forcing = null;
    }
  };

  const get = (): BackendClient | null => {
    const url = getState().backendUrl;
    if (!url) return null;
    if (client && clientUrl === url) return client;
    client?.dispose();
    client = new BackendClient({
      baseUrl: url,
      getToken: async (options) =>
        options?.force ? await forceToken() : cachedToken(),
    });
    clientUrl = url;
    return client;
  };

  return {
    /** The client, or null until the backend URL is configured. */
    client: get,
    /** Like `client()`, but throws a readable error while unconfigured. */
    require(): BackendClient {
      const current = get();
      if (!current) throw new Error("Stella's cloud is not configured on this device yet.");
      return current;
    },
    setBackendUrl(value: string | null): void {
      getState().backendUrl =
        sanitizeBackendUrl(value) ?? sanitizeBackendUrl(process.env.STELLA_BACKEND_URL);
    },
    /** Call after the auth token changes; reconnects only when the account did. */
    noteAuthToken(): void {
      const next = tokenSubject(getState().authToken);
      if (next === subject) return;
      subject = next;
      identity = null;
      client?.reconnect();
    },
    /**
     * The verified owner identity, asked once per account. A failure is not
     * cached, so the next caller asks again.
     */
    async ownerIdentity(): Promise<OwnerIdentity> {
      if (identity && identity.subject === subject) return await identity.value;
      const value = this.require().call("owner.identity", {});
      identity = { subject, value };
      try {
        return await value;
      } catch (error) {
        if (identity?.value === value) identity = null;
        throw error;
      }
    },
    /** Drop the cached identity, e.g. after the owner reset their data. */
    forgetOwnerIdentity(): void {
      identity = null;
    },
    dispose(): void {
      client?.dispose();
      client = null;
      clientUrl = null;
    },
  };
};

export const initialBackendUrl = (): string | null =>
  sanitizeBackendUrl(process.env.STELLA_BACKEND_URL);
