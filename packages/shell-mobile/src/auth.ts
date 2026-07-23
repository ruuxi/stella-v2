import { expoClient } from "@better-auth/expo/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import {
  anonymousClient,
  magicLinkClient,
} from "better-auth/client/plugins";
import type { BetterFetchPlugin } from "@better-fetch/fetch";
import * as SecureStore from "expo-secure-store";
import { mobileConfig } from "./config";

const plugins = [
  expoClient({
    scheme: mobileConfig.scheme,
    storage: SecureStore,
    storagePrefix: "stella-mobile",
  }),
  convexClient(),
  anonymousClient(),
  magicLinkClient(),
  {
    id: "stella-mobile-origin",
    fetchPlugins: [
      {
        id: "stella-mobile-origin",
        name: "Stella mobile origin",
        async init(url, options) {
          const headers = (options?.headers ?? {}) as Record<string, string>;
          return {
            url,
            options: {
              ...options,
              headers: {
                ...headers,
                origin: mobileConfig.convexSiteUrl,
              },
            },
          };
        },
      } satisfies BetterFetchPlugin,
    ],
  },
];

export const authClient = createAuthClient({
  baseURL: mobileConfig.convexSiteUrl,
  plugins,
});

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let inFlightToken: Promise<string> | null = null;

const tokenExpiration = (token: string): number => {
  const encoded = token.split(".")[1];
  if (!encoded) return Date.now() + 3 * 60_000;
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const payload = JSON.parse(globalThis.atob(padded)) as { exp?: number };
  return typeof payload.exp === "number"
    ? payload.exp * 1_000 - 60_000
    : Date.now() + 3 * 60_000;
};

const loadToken = async (): Promise<string> => {
  let session = await authClient.getSession();
  if (!session.data) {
    const result = await authClient.signIn.anonymous();
    if (result.error) {
      throw new Error(
        result.error.message ?? "Stella could not create a mobile session.",
      );
    }
    session = await authClient.getSession();
  }
  if (!session.data) throw new Error("Stella could not verify the mobile session.");
  const result = await authClient.convex.token();
  const token = result.data?.token;
  if (!token) throw new Error("Stella could not obtain a Convex access token.");
  cachedToken = token;
  cachedTokenExpiresAt = tokenExpiration(token);
  return token;
};

export const getMobileConvexToken = async (force = false): Promise<string> => {
  if (!force && cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }
  if (inFlightToken) return inFlightToken;
  inFlightToken = loadToken().finally(() => {
    inFlightToken = null;
  });
  return inFlightToken;
};
