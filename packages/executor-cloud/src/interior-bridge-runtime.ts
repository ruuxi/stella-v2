import type { Plugin } from "vite";

export const STELLA_INTERIOR_BRIDGE_PROTOCOL = 1 as const;
export const STELLA_INTERIOR_BRIDGE_ASSET =
  "assets/stella-interior-bridge.js" as const;

type InteriorBridgeRuntimeOptions = {
  parentOrigin: string;
  gatewayOrigin: string;
};

const requireHttpsOrigin = (
  value: string | undefined,
  label: string,
): string => {
  try {
    const parsed = new URL(value?.trim() ?? "");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("not an origin");
    }
    return parsed.origin;
  } catch {
    throw new Error(`${label} must be configured as an HTTPS origin.`);
  }
};

export const readInteriorBridgeRuntimeOptions =
  (): InteriorBridgeRuntimeOptions => ({
    parentOrigin: requireHttpsOrigin(
      process.env.VITE_STELLA_APPS_HOST,
      "VITE_STELLA_APPS_HOST",
    ),
    gatewayOrigin: requireHttpsOrigin(
      process.env.VITE_STELLA_APPS_AUTH_HOST,
      "VITE_STELLA_APPS_AUTH_HOST",
    ),
  });

/**
 * This source is emitted by the immutable candidate builder, not read from the
 * editable world. It executes as a classic script before any interior module.
 * The frozen bridge is installed synchronously, then its methods wait for the
 * fixed parent to complete a one-shot nonce handshake. No account credential is
 * present in that handshake or exposed by this module.
 */
export const createInteriorBridgeRuntimeSource = (
  options: InteriorBridgeRuntimeOptions,
): string => `(() => {
  "use strict";
  const VERSION = ${STELLA_INTERIOR_BRIDGE_PROTOCOL};
  const INIT_SOURCE = "stella-interior-parent-init-v1";
  const READY_SOURCE = "stella-interior-child-ready-v1";
  const CHILD_SOURCE = "stella-interior-child-v1";
  const PARENT_SOURCE = "stella-interior-parent-v1";
  const FIXED_PARENT_ORIGIN = ${JSON.stringify(options.parentOrigin)};
  const FIXED_GATEWAY_ORIGIN = ${JSON.stringify(options.gatewayOrigin)};
  const pending = new Map();
  let authority = null;
  let resolveAuthority;
  const authorityPromise = new Promise((resolve) => { resolveAuthority = resolve; });

  const isExactInit = (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const expectedKeys = ["gatewayOrigin", "nonce", "source", "stableRouteId", "v"];
    const actualKeys = Object.keys(message).sort();
    return actualKeys.length === expectedKeys.length &&
      expectedKeys.every((key, index) => actualKeys[index] === key) &&
      message.source === INIT_SOURCE &&
      message.v === VERSION &&
      typeof message.nonce === "string" &&
      /^[A-Za-z0-9_-]{22,128}$/.test(message.nonce) &&
      message.gatewayOrigin === FIXED_GATEWAY_ORIGIN &&
      typeof message.stableRouteId === "string" &&
      /^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.stableRouteId);
  };

  const request = async (method) => {
    const activeAuthority = await authorityPromise;
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeoutSignal = AbortSignal.timeout(15000);
      const onTimeout = () => {
        pending.delete(id);
        reject(new Error("The Stella interior bridge timed out."));
      };
      timeoutSignal.addEventListener("abort", onTimeout, { once: true });
      pending.set(id, {
        resolve: (value) => {
          timeoutSignal.removeEventListener("abort", onTimeout);
          resolve(value);
        },
        reject: (error) => {
          timeoutSignal.removeEventListener("abort", onTimeout);
          reject(error);
        },
      });
      window.parent.postMessage({
        source: CHILD_SOURCE,
        v: VERSION,
        nonce: activeAuthority.nonce,
        id,
        method,
      }, activeAuthority.parentOrigin);
    });
  };

  const readSession = (value) => {
    const user = value?.user;
    if (
      !user || typeof user !== "object" ||
      typeof user.id !== "string" || !user.id ||
      typeof user.isAnonymous !== "boolean" ||
      typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
    ) throw new Error("The Stella interior session response was invalid.");
    return Object.freeze({
      user: Object.freeze({
        id: user.id,
        email: typeof user.email === "string" ? user.email : null,
        name: typeof user.name === "string" ? user.name : null,
        image: typeof user.image === "string" ? user.image : null,
        isAnonymous: user.isAnonymous,
      }),
      expiresAt: value.expiresAt,
    });
  };

  const readToken = (value) => {
    if (
      typeof value?.token !== "string" ||
      value.token.length < 16 || value.token.length > 8192 ||
      typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
    ) throw new Error("The Stella interior token response was invalid.");
    return Object.freeze({ token: value.token, expiresAt: value.expiresAt });
  };

  const bridge = Object.freeze({
    protocol: VERSION,
    gatewayOrigin: FIXED_GATEWAY_ORIGIN,
    getSession: async () => readSession(await request("session")),
    getToken: async (options = {}) => readToken(await request(
      options && options.forceRefresh === true ? "refresh" : "token"
    )),
  });
  Object.defineProperty(window, "__STELLA_INTERIOR_BRIDGE__", {
    value: bridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== FIXED_PARENT_ORIGIN
    ) return;
    const message = event.data;
    if (!authority && isExactInit(message)) {
      authority = Object.freeze({
        nonce: message.nonce,
        parentOrigin: FIXED_PARENT_ORIGIN,
      });
      resolveAuthority(authority);
      return;
    }
    if (
      !authority ||
      message?.source !== PARENT_SOURCE ||
      message.v !== VERSION ||
      message.nonce !== authority.nonce ||
      typeof message.id !== "string"
    ) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok === true) entry.resolve(message.result);
    else entry.reject(new Error(
      typeof message.error === "string" && message.error
        ? message.error.slice(0, 240)
        : "The Stella interior bridge rejected the request."
    ));
  });

  window.parent.postMessage({ source: READY_SOURCE, v: VERSION }, FIXED_PARENT_ORIGIN);
})();`;

export const createInteriorBridgePlugin = (
  options: InteriorBridgeRuntimeOptions,
): Plugin => ({
  name: "stella-immutable-interior-bridge",
  apply: "build",
  enforce: "pre",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: STELLA_INTERIOR_BRIDGE_ASSET,
      source: createInteriorBridgeRuntimeSource(options),
    });
  },
  transformIndexHtml: {
    order: "pre",
    handler() {
      return [
        {
          tag: "script",
          attrs: { src: `./${STELLA_INTERIOR_BRIDGE_ASSET}` },
          injectTo: "head-prepend",
        },
      ];
    },
  },
});
