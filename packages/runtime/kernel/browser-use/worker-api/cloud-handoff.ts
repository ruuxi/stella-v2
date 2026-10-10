/**
 * Cloud-only interaction requests: the login takeover and the device-code
 * fixture. Their parameters are checked strictly here because the cloud
 * adapter forwards them to a private gateway.
 */

import type {
  BrowserWorkerDeviceCodeFixtureOptions,
  BrowserWorkerLoginTakeoverOptions,
} from "../worker-api.js";
import { requirePositiveInteger } from "../protocol.js";
import {
  assertKnownKeys,
  requireOptions,
  requireString,
} from "./validation.js";

const cloudLoginForbiddenHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "metadata.google.internal" ||
    lower === "metadata.internal"
  ) {
    return true;
  }
  if (/^(?:127|0|10|169\.254|192\.168)\./u.test(lower)) return true;
  const match172 = /^172\.(\d{1,3})\./u.exec(lower);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) {
    return true;
  }
  return (
    lower === "::1" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  );
};

const requireCloudLoginOrigin = (value: unknown, name: string): string => {
  const raw = requireString(value, name, { maxLength: 512 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be an exact public HTTPS origin.`);
  }
  if (
    raw.trim() !== raw ||
    /[\u0000-\u001f\u007f]/u.test(raw) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== raw ||
    cloudLoginForbiddenHostname(url.hostname)
  ) {
    throw new TypeError(`${name} must be an exact public HTTPS origin.`);
  }
  return url.origin;
};

const requireCloudLoginUrl = (
  value: unknown,
  name: string,
  expectedOrigin: string,
): string => {
  const raw = requireString(value, name, { maxLength: 4_096 });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be a same-origin public HTTPS URL.`);
  }
  if (
    raw.trim() !== raw ||
    /[\u0000-\u001f\u007f]/u.test(raw) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.origin !== expectedOrigin ||
    cloudLoginForbiddenHostname(url.hostname)
  ) {
    throw new TypeError(`${name} must be a same-origin public HTTPS URL.`);
  }
  return url.toString();
};

const requireCloudLoginSelector = (value: unknown, name: string): string => {
  const selector = requireString(value, name, { maxLength: 128 });
  if (
    !/^(?:#[A-Za-z][A-Za-z0-9_-]*|\.[A-Za-z][A-Za-z0-9_-]*|\[data-testid="[A-Za-z0-9_.:-]{1,96}"\])$/u.test(
      selector,
    )
  ) {
    throw new TypeError(
      `${name} must be #id, .class, or an exact [data-testid="..."] selector.`,
    );
  }
  return selector;
};

export const loginTakeoverParams = (
  rawOptions: BrowserWorkerLoginTakeoverOptions,
): Record<string, unknown> => {
  const value = requireOptions(rawOptions, "login takeover options");
  assertKnownKeys(
    value,
    [
      "allowedOrigins",
      "displayOrigin",
      "displayTitle",
      "startUrl",
      "expiresInMs",
      "verification",
    ],
    "login takeover options",
  );
  if (
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length !== 1
  ) {
    throw new TypeError(
      "allowedOrigins must contain exactly the displayed login origin.",
    );
  }
  const allowedOrigin = requireCloudLoginOrigin(
    value.allowedOrigins[0],
    "allowedOrigins[0]",
  );
  const displayOrigin = requireCloudLoginOrigin(
    value.displayOrigin,
    "displayOrigin",
  );
  if (allowedOrigin !== displayOrigin) {
    throw new TypeError(
      "allowedOrigins[0] and displayOrigin must be the same origin.",
    );
  }
  const verification = requireOptions(
    value.verification,
    "login takeover verification",
  );
  assertKnownKeys(
    verification,
    [
      "resumeUrl",
      "expectedOrigin",
      "authenticatedSelector",
      "loggedOutSelector",
    ],
    "login takeover verification",
  );
  const expectedOrigin = requireCloudLoginOrigin(
    verification.expectedOrigin,
    "expectedOrigin",
  );
  if (expectedOrigin !== displayOrigin) {
    throw new TypeError(
      "expectedOrigin and displayOrigin must be the same origin.",
    );
  }
  const authenticatedSelector = requireCloudLoginSelector(
    verification.authenticatedSelector,
    "authenticatedSelector",
  );
  const loggedOutSelector = requireCloudLoginSelector(
    verification.loggedOutSelector,
    "loggedOutSelector",
  );
  if (authenticatedSelector === loggedOutSelector) {
    throw new TypeError(
      "authenticatedSelector and loggedOutSelector must differ.",
    );
  }
  const cleanVerification: Record<string, unknown> = {
    expectedOrigin,
    authenticatedSelector,
    loggedOutSelector,
    resumeUrl: requireCloudLoginUrl(
      verification.resumeUrl,
      "resumeUrl",
      expectedOrigin,
    ),
  };
  const result: Record<string, unknown> = {
    allowedOrigins: Object.freeze([allowedOrigin]),
    displayOrigin,
    verification: Object.freeze(cleanVerification),
  };
  if (value.displayTitle !== undefined) {
    result.displayTitle = requireString(value.displayTitle, "displayTitle", {
      maxLength: 256,
    });
  }
  if (value.startUrl !== undefined) {
    result.startUrl = requireCloudLoginUrl(
      value.startUrl,
      "startUrl",
      displayOrigin,
    );
  }
  if (value.expiresInMs !== undefined) {
    const expiresInMs = requirePositiveInteger(
      value.expiresInMs,
      "expiresInMs",
    );
    if (expiresInMs < 60_000 || expiresInMs > 30 * 60_000) {
      throw new RangeError("expiresInMs must be from 60000 to 1800000.");
    }
    result.expiresInMs = expiresInMs;
  }
  return result;
};

export const deviceCodeFixtureParams = (
  rawOptions: BrowserWorkerDeviceCodeFixtureOptions | undefined,
): Record<string, unknown> => {
  const value = requireOptions(rawOptions, "device code fixture options");
  assertKnownKeys(value, ["expiresInMs"], "device code fixture options");
  if (value.expiresInMs === undefined) return {};
  const expiresInMs = requirePositiveInteger(value.expiresInMs, "expiresInMs");
  if (expiresInMs < 60_000 || expiresInMs > 30 * 60_000) {
    throw new RangeError("expiresInMs must be from 60000 to 1800000.");
  }
  return { expiresInMs };
};
