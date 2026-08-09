import { useConvex } from "convex/react";
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { useEffect, useRef, useState } from "react";
import { uiState } from "@/platform/ui-state";

const PERSISTENT_CACHE_PREFIX = "stella:persistent-convex-one-shot:v1";
const DEFAULT_MAX_SERIALIZED_BYTES = 512 * 1024;
const persistentQueryFlights = new Map<string, Promise<unknown>>();

type PersistentConvexOneShotOptions = {
  ttlMs: number;
  scope: string;
  refreshKey?: string | number;
  /**
   * By default a valid persistent value is shown immediately and refreshed in
   * the background. Set this to false for policy checks where the cached value
   * is authoritative for its TTL and avoiding an extra request matters more
   * than background freshness. A missing or expired entry still fetches.
   */
  refreshCached?: boolean;
  cacheKey?: string;
  maxSerializedBytes?: number;
};

type PersistentCacheEntry<T> = {
  savedAt: number;
  expiresAt: number;
  data: T;
};

const readPersistentEntry = <T>(
  key: string,
): PersistentCacheEntry<T> | undefined => {
  const raw = uiState.getItem(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistentCacheEntry<T>>;
    if (
      typeof parsed.expiresAt !== "number" ||
      Date.now() >= parsed.expiresAt
    ) {
      uiState.removeItem(key);
      return undefined;
    }
    return parsed as PersistentCacheEntry<T>;
  } catch {
    uiState.removeItem(key);
    return undefined;
  }
};

const writePersistentEntry = <T>(
  key: string,
  data: T,
  ttlMs: number,
  maxSerializedBytes: number,
): number => {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  try {
    const raw = JSON.stringify({
      savedAt: now,
      expiresAt,
      data,
    } satisfies PersistentCacheEntry<T>);
    if (raw.length > maxSerializedBytes) return expiresAt;
    uiState.setItem(key, raw);
  } catch {
    /* serialization errors are non-fatal */
  }
  return expiresAt;
};

const sharedPersistentQuery = <T>(
  key: string,
  query: () => Promise<T>,
): Promise<T> => {
  const existing = persistentQueryFlights.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = query();
  persistentQueryFlights.set(key, pending);
  const clear = () => {
    if (persistentQueryFlights.get(key) === pending) {
      persistentQueryFlights.delete(key);
    }
  };
  void pending.then(clear, clear);
  return pending;
};

/**
 * One-shot Convex query that mirrors `useQuery`'s call shape but does
 * not keep an open WebSocket subscription. Use for read-mostly data
 * that won't meaningfully change while the component is mounted —
 * billing status, package metadata, identity profile, catalog rows,
 * etc. Subscriptions are still the right call when another user or
 * another window can mutate the data live (chat messages, presence,
 * job progress).
 *
 * Returns `undefined` while loading (or until the previous result
 * matches the current args / `refreshKey`), then the value, then
 * `undefined` on error. Pass `"skip"` to defer the fetch. Bump
 * `refreshKey` to force a re-fetch with the same args.
 *
 * Implementation note: `api.foo.bar` is a recursive Proxy from
 * `convex/server`'s `anyApi`, which returns a NEW `FunctionReference`
 * object on every property access. So the `query` reference is unstable
 * across renders and cannot be used directly as a `useEffect` dep —
 * doing so causes an infinite render loop. We key the effect off
 * `getFunctionName(query)` (a stable string like
 * `"data/pets:listTagFacets"`) and read the live query/args via refs.
 */
export function useConvexOneShot<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
  refreshKey?: string | number,
): FunctionReturnType<Query> | undefined {
  const convex = useConvex();
  // Args are usually constructed inline (`{ packageId }`), so we key off
  // a serialized form to match `useQuery`'s deep-equality semantics
  // instead of refiring on every fresh object reference.
  const argsKey = args === "skip" ? "__skip__" : JSON.stringify(args);
  const queryName = getFunctionName(query);
  const fetchToken = `${queryName}::${argsKey}::${refreshKey ?? ""}`;

  const queryRef = useRef(query);
  queryRef.current = query;
  const argsRef = useRef(args);
  argsRef.current = args;

  // Pair the data with the token it was fetched for so we can return
  // `undefined` (loading) when the args change but the in-flight fetch
  // hasn't landed yet — avoids briefly rendering data for the previous
  // args under a new key.
  const [entry, setEntry] = useState<{
    token: string;
    data: FunctionReturnType<Query> | undefined;
  }>({ token: "__init__", data: undefined });

  useEffect(() => {
    const currentArgs = argsRef.current;
    // The returned value is already gated by `entry.token === fetchToken`, so
    // a skipped query reads as loading without a follow-up state reset.
    if (currentArgs === "skip") return;
    let cancelled = false;
    void convex
      .query(queryRef.current, currentArgs as FunctionArgs<Query>)
      .then((result) => {
        if (cancelled) return;
        setEntry({
          token: fetchToken,
          data: result as FunctionReturnType<Query>,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setEntry({ token: fetchToken, data: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [convex, fetchToken]);

  return entry.token === fetchToken ? entry.data : undefined;
}

/**
 * Persistent variant of `useConvexOneShot` for read-mostly data that can be
 * shown immediately from renderer-local storage while the authoritative Convex
 * query refreshes in the background. Callers must pass an explicit `scope`
 * (for example an account-derived key or `"public"`) so cached rows do not
 * leak across identities.
 */
export function usePersistentConvexOneShot<
  Query extends FunctionReference<"query">,
>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
  options: PersistentConvexOneShotOptions,
): FunctionReturnType<Query> | undefined {
  const convex = useConvex();
  const argsKey = args === "skip" ? "__skip__" : JSON.stringify(args);
  const queryName = getFunctionName(query);
  const cacheKey =
    args === "skip"
      ? null
      : `${PERSISTENT_CACHE_PREFIX}:${options.scope}:${options.cacheKey ?? `${queryName}:${argsKey}`}`;
  const fetchToken = `${queryName}::${argsKey}::${options.refreshKey ?? ""}`;
  const maxSerializedBytes =
    options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES;

  const queryRef = useRef(query);
  queryRef.current = query;
  const argsRef = useRef(args);
  argsRef.current = args;
  const [expiryEpoch, setExpiryEpoch] = useState(0);

  const [entry, setEntry] = useState<{
    cacheKey: string | null;
    fetchToken: string;
    data: FunctionReturnType<Query> | undefined;
    expiresAt?: number;
  }>(() => {
    const cached = cacheKey
      ? readPersistentEntry<FunctionReturnType<Query>>(cacheKey)
      : undefined;
    return {
      cacheKey,
      fetchToken,
      data: cached?.data,
      ...(cached ? { expiresAt: cached.expiresAt } : {}),
    };
  });

  useEffect(() => {
    if (!cacheKey) {
      setEntry((prev) =>
        prev.cacheKey === null && prev.fetchToken === fetchToken
          ? prev
          : {
              cacheKey: null,
              fetchToken,
              data: undefined,
              expiresAt: undefined,
            },
      );
      return;
    }
    setEntry((prev) => {
      if (prev.cacheKey === cacheKey && prev.fetchToken === fetchToken) {
        return prev;
      }
      const cached = readPersistentEntry<FunctionReturnType<Query>>(cacheKey);
      return {
        cacheKey,
        fetchToken,
        data: cached?.data,
        expiresAt: cached?.expiresAt,
      };
    });
  }, [cacheKey, fetchToken]);

  useEffect(() => {
    if (!cacheKey || entry.cacheKey !== cacheKey || entry.expiresAt == null) {
      return;
    }
    const delayMs = Math.max(0, entry.expiresAt - Date.now() + 1);
    const timeout = window.setTimeout(() => {
      setEntry((prev) =>
        prev.cacheKey === cacheKey
          ? { ...prev, data: undefined, expiresAt: undefined }
          : prev,
      );
      setExpiryEpoch((value) => value + 1);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [cacheKey, entry.cacheKey, entry.expiresAt]);

  useEffect(() => {
    const currentArgs = argsRef.current;
    if (currentArgs === "skip" || !cacheKey) return;

    if (options.refreshCached === false) {
      const cached = readPersistentEntry<FunctionReturnType<Query>>(cacheKey);
      if (cached !== undefined) {
        setEntry((prev) =>
          prev.cacheKey === cacheKey &&
          prev.fetchToken === fetchToken &&
          prev.data === cached.data &&
          prev.expiresAt === cached.expiresAt
            ? prev
            : {
                cacheKey,
                fetchToken,
                data: cached.data,
                expiresAt: cached.expiresAt,
              },
        );
        return;
      }
    }

    let cancelled = false;
    const flightKey = `${cacheKey}::${fetchToken}`;
    void sharedPersistentQuery(flightKey, () =>
      convex.query(queryRef.current, currentArgs as FunctionArgs<Query>),
    )
      .then((result) => {
        if (cancelled) return;
        const data = result as FunctionReturnType<Query>;
        const expiresAt = writePersistentEntry(
          cacheKey,
          data,
          options.ttlMs,
          maxSerializedBytes,
        );
        setEntry({ cacheKey, fetchToken, data, expiresAt });
      })
      .catch(() => {
        // Keep any valid cached value visible when the refresh fails.
      });
    return () => {
      cancelled = true;
    };
  }, [
    cacheKey,
    convex,
    expiryEpoch,
    fetchToken,
    maxSerializedBytes,
    options.refreshCached,
    options.ttlMs,
  ]);

  return entry.cacheKey === cacheKey &&
    (entry.expiresAt == null || Date.now() < entry.expiresAt)
    ? entry.data
    : undefined;
}
