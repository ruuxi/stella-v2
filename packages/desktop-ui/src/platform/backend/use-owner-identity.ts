import { useEffect, useState } from "react";
import type { OwnerIdentity } from "@stella/contracts/backend/conversations";
import type { BackendRequestError } from "@stella/contracts/backend/client";
import { backendClient } from "./backend-client";

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

const inflight = new Map<string, Promise<OwnerIdentity>>();

/**
 * The backend's answer to "who am I": the owner id it verified from the
 * current token and the owner generation that fences stale work. Asked once
 * per `accountKey` (change the key when the account or session changes).
 * The answer is also the identity proof: a result whose `ownerId` is not the
 * expected one means the token still belongs to another account.
 */
export function useOwnerIdentity(accountKey: string | null): {
  identity: OwnerIdentity | undefined;
  error: BackendRequestError | undefined;
} {
  const [state, setState] = useState<{
    key: string | null;
    identity?: OwnerIdentity;
    error?: BackendRequestError;
  }>({ key: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!accountKey) return;
    let canceled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let request = inflight.get(accountKey);
    if (!request) {
      request = backendClient.call("owner.identity", {});
      inflight.set(accountKey, request);
    }
    request
      .then((identity) => {
        if (!canceled) setState({ key: accountKey, identity });
      })
      .catch((error: BackendRequestError) => {
        inflight.delete(accountKey);
        if (canceled) return;
        setState({ key: accountKey, error });
        if (error.retryable !== false) {
          const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
          retryTimer = setTimeout(() => setAttempt((value) => value + 1), delay);
        }
      });
    return () => {
      canceled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [accountKey, attempt]);

  const current = state.key === accountKey ? state : { key: accountKey };
  return { identity: current.identity, error: current.error };
}

/** Forget a cached identity, e.g. after the owner reset their data. */
export const forgetOwnerIdentity = (accountKey: string): void => {
  inflight.delete(accountKey);
};
