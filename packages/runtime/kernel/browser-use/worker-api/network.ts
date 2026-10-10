/**
 * `tab.network`: observe the tab's traffic, rewrite its outgoing requests,
 * and make authenticated requests from the page's own origin.
 */

import type { BrowserWorkerNetwork } from "../worker-api.js";
import {
  requireNonNegativeInteger,
  requirePositiveInteger,
  type BrowserProtocolAction,
} from "../protocol.js";
import { field } from "./context.js";
import {
  assertKnownKeys,
  isPlainObject,
  requireOptions,
  requireString,
  safeJsonValue,
  timeoutParam,
} from "./validation.js";

export const createTabNetwork = (
  boundCommand: (
    action: BrowserProtocolAction,
    params: Record<string, unknown>,
  ) => Promise<unknown>,
  tabParams: () => Record<string, unknown>,
): BrowserWorkerNetwork =>
  Object.freeze({
    requests: async (rawOptions: Record<string, unknown> = {}) => {
      const value = requireOptions(rawOptions, "requests options");
      assertKnownKeys(
        value,
        ["filter", "after", "limit", "clear"],
        "requests options",
      );
      const params: Record<string, unknown> = tabParams();
      if (value.filter !== undefined) {
        params.filter = requireString(value.filter, "filter", {
          maxLength: 8_192,
        });
      }
      if (value.after !== undefined) {
        params.after = requireNonNegativeInteger(value.after, "after");
      }
      if (value.limit !== undefined) {
        const limit = requirePositiveInteger(value.limit, "limit");
        if (limit > 256) throw new RangeError("limit must be at most 256.");
        params.limit = limit;
      }
      if (value.clear !== undefined) {
        if (typeof value.clear !== "boolean") {
          throw new TypeError("clear must be a boolean.");
        }
        params.clear = value.clear;
      }
      const data = await boundCommand("requests", params);
      const requests = field(data, "requests");
      return Object.freeze(Array.isArray(requests) ? [...requests] : []);
    },
    waitForResponse: async (
      url: string,
      action?: () => unknown | Promise<unknown>,
      rawOptions: Readonly<{ timeout?: number }> = {},
    ) => {
      if (action !== undefined && typeof action !== "function") {
        throw new TypeError("waitForResponse action must be a function.");
      }
      const value = requireOptions(rawOptions, "waitForResponse options");
      assertKnownKeys(value, ["timeout"], "waitForResponse options");
      const timeout = timeoutParam(value.timeout ?? 30_000, "timeout", 600_000);
      const pattern = requireString(url, "url", { maxLength: 16_384 });
      await boundCommand("requests", { ...tabParams(), limit: 1 });
      const after = Date.now();
      if (action) await action();
      return await boundCommand("responsebody", {
        ...tabParams(),
        url: pattern,
        after,
        timeout,
      });
    },
    rewriteRequest: async (
      url: string,
      rawOptions: Record<string, unknown>,
    ) => {
      const value = requireOptions(rawOptions, "rewriteRequest options");
      assertKnownKeys(
        value,
        ["method", "postData", "jsonPatch", "headers"],
        "rewriteRequest options",
      );
      const params: Record<string, unknown> = {
        ...tabParams(),
        url: requireString(url, "url", { maxLength: 16_384 }),
      };
      if (value.method !== undefined) {
        params.method = requireString(value.method, "method", {
          maxLength: 64,
        });
      }
      if (value.postData !== undefined) {
        params.postData = requireString(value.postData, "postData", {
          allowEmpty: true,
          maxLength: 1024 * 1024,
        });
      }
      if (value.jsonPatch !== undefined) {
        if (!isPlainObject(value.jsonPatch)) {
          throw new TypeError("jsonPatch must be an object.");
        }
        params.jsonPatch = safeJsonValue(value.jsonPatch, "jsonPatch");
      }
      if (value.headers !== undefined) {
        if (!isPlainObject(value.headers)) {
          throw new TypeError("headers must be an object.");
        }
        const headers: Record<string, string> = {};
        for (const [name, headerValue] of Object.entries(value.headers)) {
          headers[requireString(name, "header name", { maxLength: 256 })] =
            requireString(headerValue, `headers.${name}`, {
              allowEmpty: true,
              maxLength: 8_192,
            });
        }
        params.headers = headers;
      }
      return await boundCommand("rewrite_request", params);
    },
    clearRequestRewrite: async (url?: string) => {
      const params: Record<string, unknown> = tabParams();
      if (url !== undefined) {
        params.url = requireString(url, "url", { maxLength: 16_384 });
      }
      return await boundCommand("unrewrite_request", params);
    },
    fetch: async (url: string, rawOptions: Record<string, unknown> = {}) => {
      const value = requireOptions(rawOptions, "fetch options");
      assertKnownKeys(
        value,
        ["method", "headers", "body", "timeout", "maxBodyBytes"],
        "fetch options",
      );
      const params: Record<string, unknown> = {
        ...tabParams(),
        url: requireString(url, "url", { maxLength: 16_384 }),
      };
      if (value.method !== undefined) {
        params.method = requireString(value.method, "method", {
          maxLength: 64,
        });
      }
      if (value.body !== undefined) {
        params.body = requireString(value.body, "body", {
          allowEmpty: true,
          maxLength: 1024 * 1024,
        });
      }
      if (value.timeout !== undefined) {
        params.timeout = timeoutParam(value.timeout, "timeout", 600_000);
      }
      if (value.maxBodyBytes !== undefined) {
        const maximum = requirePositiveInteger(
          value.maxBodyBytes,
          "maxBodyBytes",
        );
        if (maximum > 1024 * 1024) {
          throw new RangeError("maxBodyBytes must be at most 1048576.");
        }
        params.maxBodyBytes = maximum;
      }
      if (value.headers !== undefined) {
        if (!isPlainObject(value.headers)) {
          throw new TypeError("headers must be an object.");
        }
        params.headers = safeJsonValue(value.headers, "headers");
      }
      return await boundCommand("authenticated_request", params);
    },
    fetchAll: async (
      rawRequests: readonly Record<string, unknown>[],
      rawOptions: Record<string, unknown> = {},
    ) => {
      if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
        throw new TypeError("fetchAll requests must be a non-empty array.");
      }
      if (rawRequests.length > 100) {
        throw new RangeError("fetchAll accepts at most 100 requests.");
      }
      const value = requireOptions(rawOptions, "fetchAll options");
      assertKnownKeys(value, ["concurrency", "timeout"], "fetchAll options");
      const concurrency = requirePositiveInteger(
        value.concurrency ?? 4,
        "concurrency",
      );
      if (concurrency > 4) {
        throw new RangeError("concurrency must be from 1 to 4.");
      }
      const timeout = timeoutParam(value.timeout ?? 30_000, "timeout", 600_000);
      const requests = rawRequests.map((request, index) => {
        const options = requireOptions(request, `requests[${index}]`);
        assertKnownKeys(
          options,
          ["url", "method", "headers", "body", "timeout", "maxBodyBytes"],
          `requests[${index}]`,
        );
        const clean = safeJsonValue(options, `requests[${index}]`) as Record<
          string,
          unknown
        >;
        clean.url = requireString(clean.url, `requests[${index}].url`, {
          maxLength: 16_384,
        });
        return clean;
      });
      const data = await boundCommand("authenticated_request_batch", {
        ...tabParams(),
        requests,
        concurrency,
        timeout,
      });
      const responses = field(data, "responses");
      return Object.freeze(Array.isArray(responses) ? [...responses] : []);
    },
  });
