/**
 * Local tool implementations for tools that don't need the server.
 *
 * These replace the backend passthrough (`callBackendTool`) for tools
 * that can execute entirely in the Electron process:
 * - WebFetch: direct fetch() + HTML-to-text
 * - NoResponse: immediate return
 */

import { normalizeSafeExternalUrl } from "./network-guards.js";
import { containsSecretLikeToken, sanitizeToolVisibleText } from "./safety.js";
import { fetchReadableText } from "./web-fetch-core.js";

const safeUrlOptions = () => ({
  skipResolvedAddressCheck: process.env.NODE_ENV === "development",
});

// WebFetch — the pipeline itself lives in the workerd-safe
// `web-fetch-core.ts` (the cloud DO runs the same one); this wrapper binds
// the desktop capabilities: the DNS-checking URL guard and the
// secret-redacting sanitizer.

export const localWebFetch = async (args: {
  url: string;
  prompt?: string;
}): Promise<string> =>
  fetchReadableText(args, {
    guardUrl: (url) => normalizeSafeExternalUrl(url, safeUrlOptions()),
    checkSecretLikeToken: containsSecretLikeToken,
    sanitize: sanitizeToolVisibleText,
    userAgent: "Stella/1.0 (Desktop Assistant)",
  });

// NoResponse

export const localNoResponse = async (): Promise<string> => {
  return "";
};
