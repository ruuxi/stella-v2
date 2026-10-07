import { authClient } from "@/global/auth/lib/auth-client";
import {
  getAuthSessionSnapshot,
  hasBrowserLegacyAnonymousSession,
  refreshAuthSession,
} from "@/global/auth/services/auth-session";
import {
  readBrowserSessionToken,
  writeBrowserSessionToken,
} from "@/global/auth/services/auth-storage";
import { backendUrl } from "@/platform/backend/backend-url";
import { platformCapabilities } from "@/platform/capabilities";
import { captchaHeaders } from "@/platform/auth/challenge-token";

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
  const siteUrl = backendUrl || null;
  if (!siteUrl) {
    throw new Error("Stella backend URL is not set.");
  }
  const authorization = getLegacySignInOwnerAuthorization();
  const response = await fetch(`${siteUrl}/api/auth/browser-social/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
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
 * The credential a browser sign-in carries when this shell still holds a
 * bearer from the retired anonymous sign-in, so the backend upgrades that user
 * in place and keeps their history. Null for everyone else: a plain sign-in.
 * Electron never reaches this; main sends that sign-in itself.
 */
export const getLegacySignInOwnerAuthorization = (): string | null => {
  if (window.electronAPI || !hasBrowserLegacyAnonymousSession()) return null;
  const bearer = readBrowserSessionToken();
  return bearer ? `Bearer ${bearer}` : null;
};

export type MagicLinkSendRequest = {
  headers: Record<string, string>;
  body: {
    email: string;
    requireAnonymousOwner?: true;
  };
};

/**
 * A shell holding a legacy anonymous session binds the send to that owner so
 * the backend upgrades it in place; any other shell sends a plain sign-in.
 */
export const buildMagicLinkSendRequest = (
  email: string,
  turnstileToken?: string,
): MagicLinkSendRequest => {
  const authorization = getLegacySignInOwnerAuthorization();
  return {
    headers: {
      "Content-Type": "application/json",
      ...captchaHeaders(turnstileToken),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: authorization
      ? { email, requireAnonymousOwner: true }
      : { email },
  };
};

const readConnectedAccountOwnerId = (): string | null => {
  const data = getAuthSessionSnapshot().data as
    | {
        user?: {
          id?: string | null;
        } | null;
      }
    | null
    | undefined;
  return data?.user?.id?.trim() || null;
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
