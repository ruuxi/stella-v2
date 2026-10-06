import { env } from "../config/env";
import { authClient } from "./auth-client";

export const TEST_ACCOUNT_EMAIL_SUFFIX = "@test.stella.local";

const DEV_BACKEND_HOSTS = new Set([
  "stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
  "auth-dev.stella.sh",
  "localhost",
  "127.0.0.1",
]);

const backendHost = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export const devTestSessionBlocker = (
  isDevBuild: boolean,
  backendUrl: string,
): string | null => {
  if (!isDevBuild) return "Test-account sign-in exists only in development builds.";
  if (!DEV_BACKEND_HOSTS.has(backendHost(backendUrl))) {
    return `Test-account sign-in is refused for backend ${backendHost(backendUrl) || "(unset)"}; it works only against the dev backend.`;
  }
  return null;
};

export const isTestAccountEmail = (email: unknown): boolean =>
  typeof email === "string" &&
  email.trim().toLowerCase().endsWith(TEST_ACCOUNT_EMAIL_SUFFIX);

type VerifiedSession = { user?: { email?: unknown } } | null;

export const adoptDevTestSession = async (ott: string): Promise<string> => {
  const blocker = devTestSessionBlocker(__DEV__, env.backendUrl);
  if (blocker) throw new Error(blocker);
  const token = ott.trim();
  if (!token) throw new Error("The link carries no one-time token.");

  const result = await authClient.$fetch<VerifiedSession>("/one-time-token/verify", {
    method: "POST",
    body: { token },
  });
  if (result.error) {
    throw new Error(result.error.message ?? "The one-time token was rejected.");
  }
  const email = result.data?.user?.email;
  if (!isTestAccountEmail(email)) {
    await authClient.signOut();
    throw new Error(`Only ${TEST_ACCOUNT_EMAIL_SUFFIX} accounts may sign in this way.`);
  }
  await authClient.getSession({ query: { disableCookieCache: true } });
  return String(email);
};
