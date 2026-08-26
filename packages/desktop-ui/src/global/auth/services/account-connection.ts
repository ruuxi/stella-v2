import { authClient } from "@/global/auth/lib/auth-client";
import {
  getAuthSessionSnapshot,
  refreshAuthSession,
} from "@/global/auth/services/auth-session";
import {
  applyBrowserAuthSessionCookie,
  assertBetterAuthSessionCookie,
} from "@/global/auth/services/auth-storage";
import { getConvexToken } from "@/global/auth/services/auth-token";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";

type BrowserCallbackLocation = Pick<Location, "origin" | "pathname">;

/**
 * OAuth callbacks must never inherit ambient query parameters or fragments.
 * In particular, an auth credential already being consumed by the shell must
 * not be copied into a new provider callback URL.
 */
export const getBrowserSocialCallbackUrl = (
  location: BrowserCallbackLocation,
): string => new URL(location.pathname, location.origin).toString();

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
 * Electron keeps its existing host-mediated link flow. Browser shells bind
 * the send to the current anonymous owner and refuse to issue an unowned link.
 */
export const buildMagicLinkSendRequest = async (
  email: string,
): Promise<MagicLinkSendRequest | null> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (window.electronAPI) {
    return { headers, body: { email } };
  }

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
 * Apply the raw Better Auth Set-Cookie value in the renderer-specific storage,
 * then perform an authoritative session read. A completed poll without a
 * verifiable connected-account owner is treated as a failed link.
 */
export const applyAndVerifyAccountSessionCookie = async (
  sessionCookie: string,
): Promise<void> => {
  const normalized = sessionCookie.trim();
  if (!normalized) {
    throw new Error("Missing account session cookie.");
  }
  assertBetterAuthSessionCookie(normalized);

  if (window.electronAPI) {
    const applySessionCookie = window.electronAPI.system.applyAuthSessionCookie;
    if (!applySessionCookie) {
      throw new Error("Desktop account session storage is unavailable.");
    }
    const result = await applySessionCookie(normalized);
    if (!result?.ok) {
      throw new Error("Desktop account session storage rejected the cookie.");
    }
  } else {
    applyBrowserAuthSessionCookie(normalized);
    authClient.updateSession();
  }

  await refreshAuthSession();
  if (!readConnectedAccountOwnerId()) {
    throw new Error("The connected account session could not be verified.");
  }
};
