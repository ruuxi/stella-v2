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

export function useConvexOneShot<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
  refreshKey?: string | number,
): FunctionReturnType<Query> | undefined {
  const convex = useConvex();

  const argsKey = args === "skip" ? "__skip__" : JSON.stringify(args);
  const queryName = getFunctionName(query);
  const fetchToken = `${queryName}::${argsKey}::${refreshKey ?? ""}`;

  const queryRef = useRef(query);
  queryRef.current = query;
  const argsRef = useRef(args);
  argsRef.current = args;

  const [entry, setEntry] = useState<{
    token: string;
    data: FunctionReturnType<Query> | undefined;
  }>({ token: "__init__", data: undefined });

  useEffect(() => {
    const currentArgs = argsRef.current;

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
