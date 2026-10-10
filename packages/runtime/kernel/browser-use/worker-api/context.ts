/**
 * Per-install state shared by the worker API modules: the selected backend,
 * the current generation of every numeric tab id, and the command transport
 * to the host's browser session.
 */

import type {
  BrowserWorkerBackend,
  BrowserWorkerCall,
  BrowserWorkerChainOptions,
  BrowserWorkerChainStep,
} from "../worker-api.js";
import {
  WORKER_BOUND_BACKEND_PARAM,
  type BrowserSessionAction,
} from "../protocol.js";
import { isPlainObject } from "./validation.js";

// Effect-ratchet pin (1 setTimeout): this module is bundled into the
// Node REPL eval worker (see worker-api-source.ts), which has no Effect
// runtime, so the raw timer is the only scheduling primitive available.
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const normalizeError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  if (isPlainObject(value)) {
    const message =
      typeof value.error === "string"
        ? value.error
        : typeof value.message === "string"
          ? value.message
          : "Browser command failed.";
    return new Error(message);
  }
  return new Error(String(value ?? "Browser command failed."));
};

export const isLegacyTabGeneration = (generation: string): boolean =>
  generation.startsWith("legacy:");

export const tabGenerationParams = (
  generation: string,
): Readonly<{ tabGeneration?: string }> =>
  isLegacyTabGeneration(generation) ? {} : { tabGeneration: generation };

const unwrapResponse = (value: unknown): unknown => {
  let envelope = value;
  if (
    isPlainObject(envelope) &&
    isPlainObject(envelope.result) &&
    typeof envelope.result.success === "boolean"
  ) {
    envelope = envelope.result;
  } else if (
    isPlainObject(envelope) &&
    isPlainObject(envelope.response) &&
    typeof envelope.response.success === "boolean"
  ) {
    envelope = envelope.response;
  }
  if (isPlainObject(envelope) && envelope.success === false) {
    throw normalizeError(envelope);
  }
  if (
    isPlainObject(envelope) &&
    typeof envelope.success === "boolean" &&
    Object.prototype.hasOwnProperty.call(envelope, "data")
  ) {
    return envelope.data;
  }
  return envelope;
};

export const field = (value: unknown, key: string): unknown =>
  isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;

export const fieldOrSelf = (value: unknown, key: string): unknown =>
  isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : value;

export const stringField = (
  value: unknown,
  key: string,
  fallback = "",
): string => {
  const candidate = field(value, key);
  return typeof candidate === "string" ? candidate : fallback;
};

export const booleanField = (
  value: unknown,
  key: string,
  fallback = false,
): boolean => {
  const candidate = field(value, key);
  if (typeof candidate === "boolean") return candidate;
  if (candidate === "true") return true;
  if (candidate === "false") return false;
  return fallback;
};

export const numberField = (
  value: unknown,
  key: string,
  fallback = 0,
): number => {
  const candidate = field(value, key);
  const number =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && candidate.trim() !== ""
        ? Number(candidate)
        : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
};

export const chainStepData = (value: unknown, index: number): unknown => {
  const results = field(value, "results");
  if (!Array.isArray(results) || results.length <= index) return value;
  const step = results[index];
  if (isPlainObject(step) && step.success === false) throw normalizeError(step);
  if (
    isPlainObject(step) &&
    Object.prototype.hasOwnProperty.call(step, "data")
  ) {
    return step.data;
  }
  return fieldOrSelf(step, "result");
};

// Tab and Locator keep their methods on a frozen prototype, which
// Object.keys()/console.log cannot see; agents probing the API then
// conclude the objects have no methods and never find the keyboard or
// press(). Mirror the public surface onto every instance as enumerable own
// properties (same functions/getters, so behavior and identity are
// unchanged) before the instance is frozen.
export const exposePublicApi = (
  instance: object,
  names: readonly string[],
): void => {
  const prototype = Object.getPrototypeOf(instance) as object | null;
  if (!prototype) return;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor) continue;
    Object.defineProperty(instance, name, {
      ...descriptor,
      enumerable: true,
    });
  }
};

export type BrowserWorkerContext = ReturnType<
  typeof createBrowserWorkerContext
>;

export const createBrowserWorkerContext = (callBrowser: BrowserWorkerCall) => {
  let selectedBackend: BrowserWorkerBackend = "in-app";
  const currentTabGeneration = new Map<string, string>();
  const generationKey = (
    backend: BrowserWorkerBackend,
    tabId: number,
  ): string => `${backend}:${tabId}`;
  const assertCurrentTabGeneration = (
    tabId: number,
    generation: string,
    backend: BrowserWorkerBackend = selectedBackend,
  ): void => {
    const current = currentTabGeneration.get(generationKey(backend, tabId));
    if (current !== undefined && current !== generation) {
      throw new Error(
        `Stale browser tab handle ${tabId} generation ${generation}; the numeric tab id now refers to generation ${current}. Call browser.tabs.list() and use the current handle.`,
      );
    }
  };
  const stampTabGeneration = (
    params: Record<string, unknown>,
    backend: BrowserWorkerBackend = selectedBackend,
  ): Record<string, unknown> => {
    const tabId = params.tabId;
    if (
      params.tabGeneration !== undefined ||
      !Number.isSafeInteger(tabId) ||
      (tabId as number) <= 0
    ) {
      return params;
    }
    const generation = currentTabGeneration.get(
      generationKey(backend, tabId as number),
    );
    if (generation === undefined || isLegacyTabGeneration(generation)) {
      return params;
    }
    return { ...params, tabGeneration: generation };
  };
  const command = async (
    action: BrowserSessionAction,
    params: Record<string, unknown>,
    backend?: BrowserWorkerBackend,
  ): Promise<unknown> =>
    unwrapResponse(
      await callBrowser("command", [
        action,
        {
          ...stampTabGeneration(params, backend),
          ...(backend ? { [WORKER_BOUND_BACKEND_PARAM]: backend } : {}),
        },
      ]),
    );
  const sendChain = async (
    steps: readonly BrowserWorkerChainStep[],
    chainOptions: BrowserWorkerChainOptions,
    backend?: BrowserWorkerBackend,
  ): Promise<unknown> =>
    unwrapResponse(
      await callBrowser("chain", [
        steps,
        {
          ...chainOptions,
          ...(backend ? { [WORKER_BOUND_BACKEND_PARAM]: backend } : {}),
        },
      ]),
    );
  const normalizeTabGeneration = (
    value: unknown,
    tabId: number,
    name: string,
    backend: BrowserWorkerBackend = selectedBackend,
  ): string => {
    if (value === undefined || value === null) {
      return (
        currentTabGeneration.get(generationKey(backend, tabId)) ??
        `legacy:${backend}:${tabId}`
      );
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${name} must be a non-empty string.`);
    }
    return value.trim();
  };
  const rememberTabGeneration = (
    backend: BrowserWorkerBackend,
    tabId: number,
    generation: string,
  ): void => {
    currentTabGeneration.set(generationKey(backend, tabId), generation);
  };

  return {
    get selectedBackend(): BrowserWorkerBackend {
      return selectedBackend;
    },
    set selectedBackend(backend: BrowserWorkerBackend) {
      selectedBackend = backend;
    },
    assertCurrentTabGeneration,
    normalizeTabGeneration,
    rememberTabGeneration,
    command,
    sendChain,
  };
};
