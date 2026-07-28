import dns from "dns/promises";
import {
  normalizeSafePublicUrl,
  type NormalizeSafePublicUrlOptions,
} from "./url-guard.js";

export type NormalizeSafeExternalUrlOptions = {
  /**
   * When true, only the hostname string is validated (no localhost/private literals).
   * DNS is not checked — use in development when VPN/DNS maps public names to private IPs.
   */
  skipResolvedAddressCheck?: boolean;
};

/**
 * The node-side entry to the shared SSRF guard (`url-guard.ts`): identical
 * classification everywhere, plus a real DNS check so names resolving into
 * blocked space are refused before any connection is dialed.
 */
export const normalizeSafeExternalUrl = async (
  inputUrl: string,
  options?: NormalizeSafeExternalUrlOptions,
) => {
  const guardOptions: NormalizeSafePublicUrlOptions = {
    resolveHost: async (hostname) =>
      (await dns.lookup(hostname, { all: true })).map(
        (result) => result.address,
      ),
    ...(options?.skipResolvedAddressCheck
      ? { skipResolvedAddressCheck: true }
      : {}),
  };
  return normalizeSafePublicUrl(inputUrl, guardOptions);
};
