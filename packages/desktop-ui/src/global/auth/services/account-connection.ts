import { authClient } from "@/global/auth/lib/auth-client";
import {
  getAuthSessionSnapshot,
  refreshAuthSession,
} from "@/global/auth/services/auth-session";
import { writeBrowserSessionToken } from "@/global/auth/services/auth-storage";
import { getConvexToken } from "@/global/auth/services/auth-token";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { platformCapabilities } from "@/platform/capabilities";

type BrowserCallbackLocation = Pick<Location, "origin" | "pathname">;

/**
 * OAuth callbacks must never inherit ambient query parameters or fragments.
 * In particular, an auth credential already being consumed by the shell must
 * not be copied into a new provider callback URL.
 */
export const getBrowserSocialCallbackUrl = (
  location: BrowserCallbackLocation,
  website = platformCapabilities.website,
): string =>
  new URL(website ? "/chat" : location.pathname, location.origin).toString();

const readBrowserSocialBridgeCallback = (
  raw: unknown,
  expectedSiteUrl: string,
): string | null => {
  if (typeof raw !== "string") return null;
  try {
    const callback = new URL(raw);
    const expectedOrigin = new URL(expectedSiteUrl).origin;
    const requestIds = callback.searchParams.getAll("requestId");
    if (
      callback.origin !== expectedOrigin ||
      callback.username ||
      callback.password ||
      (callback.protocol !== "https:" &&
        !(
          callback.protocol === "http:" &&
          (callback.hostname === "localhost" ||
            callback.hostname === "127.0.0.1")
        )) ||
      callback.pathname !== "/api/auth/browser-social/verify" ||
      callback.hash ||
      callback.searchParams.has("ott") ||
      requestIds.length !== 1 ||
      !/^[A-Za-z0-9_-]{32,64}$/.test(requestIds[0] ?? "") ||
      Array.from(callback.searchParams.keys()).some(
        (key) => key !== "requestId",
      )
    ) {
      return null;
    }
    return callback.toString();
  } catch {
    return null;
  }
};

export const startBrowserGoogleSignIn = async () => {
  const siteUrl = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  const authorization = await getBrowserOwnerAuthorization();
  if (!siteUrl || !authorization) {
    throw new Error("Browser account ownership could not be verified.");
  }
  const response = await fetch(`${siteUrl}/api/auth/browser-social/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({
      returnTo: getBrowserSocialCallbackUrl(window.location),
    }),
  });
  const data = (await response.json().catch(() => null)) as {
    callbackURL?: unknown;
  } | null;
  const callbackURL = readBrowserSocialBridgeCallback(
    data?.callbackURL,
    siteUrl,
  );
  if (!response.ok || !callbackURL) {
    throw new Error("Browser account callback could not be registered.");
  }
  return authClient.signIn.social({
    provider: "google",
    callbackURL,
  });
};

/**
 * Mint a fresh owner token immediately before beginning an account link. A
 * cached or missing token could bind the request to the wrong anonymous owner,
 * so callers must fail closed when this returns null.
 */
export const getBrowserOwnerAuthorization = async (): Promise<
  string | null
> => {
  const token = (await getConvexToken({ forceRefresh: true }))?.trim();
  return token ? `Bearer ${token}` : null;
};

export type MagicLinkSendRequest = {
  headers: Record<string, string>;
  body: {
    email: string;
    requireAnonymousOwner?: true;
  };
};

/**
 * Every shell binds the send to the current anonymous owner and refuses to
 * issue an unowned link. `getConvexToken` obtains Electron authority through
 * host IPC and browser authority through Better Auth, so the backend receives
 * the same proof without moving session cookies across either boundary.
 */
export const buildMagicLinkSendRequest = async (
  email: string,
): Promise<MagicLinkSendRequest | null> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const authorization = await getBrowserOwnerAuthorization();
  if (!authorization) {
    return null;
  }
  return {
    headers: { ...headers, Authorization: authorization },
    body: { email, requireAnonymousOwner: true },
  };
};

const readConnectedAccountOwnerId = (): string | null => {
  const data = getAuthSessionSnapshot().data as
    | {
        user?: {
          id?: string | null;
          isAnonymous?: boolean | null;
        } | null;
      }
    | null
    | undefined;
  const ownerId = data?.user?.id?.trim();
  return ownerId && data?.user?.isAnonymous !== true ? ownerId : null;
};

/**
 * Install a claimed bearer token in whichever store owns credentials for this
 * shell, then perform an authoritative session read. A completed poll without a
 * verifiable connected-account owner is treated as a failed link.
 *
 * Electron hands the token to main, which is the only token authority there.
 * A browser shell writes it to its own local store. Either way the link
 * finishes in the shell the user started it from, so no path asks them to sign
 * in twice.
 */
export const applyAndVerifyAccountSessionToken = async (
  sessionToken: string,
): Promise<void> => {
  const normalized = sessionToken.trim();
  if (!normalized) {
    throw new Error("Missing account session token.");
  }

  if (window.electronAPI) {
    const applySessionToken = window.electronAPI.system.applyAuthSessionToken;
    if (!applySessionToken) {
      throw new Error("Desktop account session storage is unavailable.");
    }
    const result = await applySessionToken(normalized);
    if (!result?.ok) {
      throw new Error("Desktop account session storage rejected the token.");
    }
  } else {
    writeBrowserSessionToken(normalized);
    authClient.updateSession();
  }

  await refreshAuthSession();
  if (!readConnectedAccountOwnerId()) {
    throw new Error("The connected account session could not be verified.");
  }
};
