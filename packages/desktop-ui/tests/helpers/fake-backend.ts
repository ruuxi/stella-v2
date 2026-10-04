/**
 * A scripted stand-in for `@/platform/backend/backend-client`. Tests mock the
 * module with `fakeBackendModule` and then answer views and calls by hand:
 *
 *   vi.mock("@/platform/backend/backend-client", async () =>
 *     (await import("../../helpers/fake-backend")).fakeBackendModule());
 */

import { BackendRequestError, stableStringify } from "@stella/contracts/backend/client";
import type { BackendError } from "@stella/contracts/backend/protocol";

type Listener = {
  onValue: (value: unknown) => void;
  onError?: (error: BackendRequestError) => void;
};

const viewKey = (view: string, args: unknown): string => `${view}${stableStringify(args)}`;

const values = new Map<string, unknown>();
const errors = new Map<string, BackendError>();
const listeners = new Map<string, Set<Listener>>();
const calls: Array<{ name: string; args: unknown }> = [];
const callHandlers = new Map<string, (args: unknown) => unknown>();
let epoch = 0;
const epochListeners = new Set<() => void>();

export const fakeBackend = {
  /** Every view key currently subscribed. */
  subscribed(): string[] {
    return [...listeners.entries()]
      .filter(([, set]) => set.size > 0)
      .map(([key]) => key);
  },
  isSubscribed(view: string, args: unknown): boolean {
    return (listeners.get(viewKey(view, args))?.size ?? 0) > 0;
  },
  /** Answer (or update) a view; current and future subscribers get it. */
  emit(view: string, args: unknown, value: unknown): void {
    const key = viewKey(view, args);
    values.set(key, value);
    errors.delete(key);
    for (const listener of listeners.get(key) ?? []) listener.onValue(value);
  },
  fail(view: string, args: unknown, error: BackendError): void {
    const key = viewKey(view, args);
    errors.set(key, error);
    for (const listener of listeners.get(key) ?? []) {
      listener.onError?.(new BackendRequestError(error));
    }
  },
  onCall(name: string, handler: (args: unknown) => unknown): void {
    callHandlers.set(name, handler);
  },
  calls,
  bumpAccount(): void {
    epoch += 1;
    for (const listener of epochListeners) listener();
  },
  reset(): void {
    values.clear();
    errors.clear();
    listeners.clear();
    calls.length = 0;
    callHandlers.clear();
  },
};

export const fakeBackendClient = {
  watch(
    view: string,
    args: unknown,
    onValue: (value: unknown) => void,
    onError?: (error: BackendRequestError) => void,
  ): () => void {
    const key = viewKey(view, args);
    const set = listeners.get(key) ?? new Set<Listener>();
    listeners.set(key, set);
    const listener: Listener = { onValue, ...(onError ? { onError } : {}) };
    set.add(listener);
    if (values.has(key)) onValue(values.get(key));
    else if (errors.has(key)) onError?.(new BackendRequestError(errors.get(key)!));
    return () => set.delete(listener);
  },
  async call(name: string, args: unknown): Promise<unknown> {
    calls.push({ name, args });
    const handler = callHandlers.get(name);
    if (!handler) {
      throw new BackendRequestError({ code: "NOT_FOUND", message: `No fake for ${name}`, retryable: false });
    }
    return await handler(args);
  },
  reconnect(): void {},
};

export const FAKE_BACKEND_URL = "https://backend.example";

export const fakeBackendModule = () => ({
  backendClient: fakeBackendClient,
  backendUrl: FAKE_BACKEND_URL,
  backendSocketUrl: FAKE_BACKEND_URL.replace(/^http/, "ws"),
  setBackendAccount: () => {},
  subscribeBackendAccount: (listener: () => void) => {
    epochListeners.add(listener);
    return () => epochListeners.delete(listener);
  },
  readBackendAccountEpoch: () => epoch,
});
