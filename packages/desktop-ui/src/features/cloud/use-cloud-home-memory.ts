import { useCallback, useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import type {
  CloudMemoryDocument,
  CloudMemorySnapshot,
} from "@stella/contracts/cloud-home-sync";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import type { AuthSessionScopeData } from "@/global/auth/lib/auth-session-scope";
import { resolveAuthSessionCacheScope } from "@/global/auth/lib/auth-session-scope";
import { getAuthSessionSnapshot } from "@/global/auth/services/auth-session";
import { getConvexTokenForSubject } from "@/global/auth/services/auth-token";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { cloudHomeApi, type CloudMemoryWipeStatus } from "./cloud-home-api";
import {
  beginCloudMemoryDocumentWrite,
  CloudHomeMemoryError,
  createCloudHomeMemoryClient,
  type CloudHomeMemoryClientIdentity,
} from "./cloud-home-memory-client";
import { decodeCloudMemoryWipeStatus } from "./cloud-memory-wipe";

const tokenIssuer = readConfiguredConvexSiteUrl(
  import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
);

const readOwnerToken = async (ownerSubject: string): Promise<string> => {
  const token = await getConvexTokenForSubject(ownerSubject);
  if (!token) throw new CloudHomeMemoryError("unauthorized");
  return token;
};

const identityFromCurrentSession = (): CloudHomeMemoryClientIdentity | null => {
  const snapshot = getAuthSessionSnapshot();
  if (snapshot.isPending || !snapshot.data) return null;
  const data = snapshot.data as Exclude<AuthSessionScopeData, null | undefined>;
  const rawSubject = data.user?.id?.trim();
  if (!tokenIssuer || !rawSubject) return null;
  return Object.freeze({
    accountScope: resolveAuthSessionCacheScope(data),
    identityRevision: snapshot.identityRevision,
    expectedSubject: `${tokenIssuer}|${rawSubject}`,
  });
};

export type CloudHomeMemoryWriteInput = Readonly<{
  ownerGeneration: string;
  memoryEpoch: string;
  document: CloudMemoryDocument;
  content: string;
}>;

export type UseCloudHomeMemoryResult = Readonly<{
  identity: CloudHomeMemoryClientIdentity | null;
  lifecycle: CloudMemoryWipeStatus | null;
  available: boolean;
  loading: boolean;
  unavailable: boolean;
  listMemory: () => Promise<CloudMemorySnapshot>;
  writeMemory: (
    input: CloudHomeMemoryWriteInput,
  ) => ReturnType<
    ReturnType<typeof createCloudHomeMemoryClient>["writeMemory"]
  >;
}>;

/** Authenticated desktop list/edit surface for cloud-canonical Memory files. */
export const useCloudHomeMemory = (): UseCloudHomeMemoryResult => {
  const session = useAuthSessionState();
  const { cloudMode, accountScope, identityRevision, ownerSubject } =
    useCloudMode();
  const identity = useMemo<CloudHomeMemoryClientIdentity | null>(() => {
    if (
      !cloudMode ||
      !ownerSubject ||
      session.cacheScope !== accountScope ||
      session.identityRevision !== identityRevision
    ) {
      return null;
    }
    return Object.freeze({
      accountScope,
      identityRevision,
      expectedSubject: ownerSubject,
    });
  }, [
    accountScope,
    cloudMode,
    identityRevision,
    ownerSubject,
    session.cacheScope,
    session.identityRevision,
  ]);
  const requests = useMemo<RequestForQueries>(() => {
    const next: RequestForQueries = {};
    if (identity) {
      next.realtime = {
        query: cloudHomeApi.getCloudRealtimeConfig,
        args: {},
      };
      next.memoryLifecycle = {
        query: cloudHomeApi.getMyMemoryWipeStatus,
        args: { expectedSubject: identity.expectedSubject },
      };
    }
    return next;
  }, [identity]);
  const queryResults = useQueries(requests);
  const configResult = queryResults.realtime;
  const lifecycleResult = queryResults.memoryLifecycle;
  const config =
    configResult === undefined || configResult instanceof Error
      ? null
      : configResult;
  const lifecycle = useMemo<CloudMemoryWipeStatus | null>(() => {
    if (
      !identity ||
      lifecycleResult === undefined ||
      lifecycleResult instanceof Error
    ) {
      return null;
    }
    try {
      return decodeCloudMemoryWipeStatus(
        lifecycleResult,
        identity.expectedSubject,
      );
    } catch {
      return null;
    }
  }, [identity, lifecycleResult]);
  const client = useMemo(() => {
    if (!identity || config?.protocol !== 1 || !config.httpOrigin) return null;
    try {
      return createCloudHomeMemoryClient({
        builderOrigin: config.httpOrigin,
        identity,
        getCurrentIdentity: identityFromCurrentSession,
        getTokenForSubject: readOwnerToken,
      });
    } catch {
      return null;
    }
  }, [config?.httpOrigin, config?.protocol, identity]);
  const listMemory = useCallback(async () => {
    if (!client) throw new CloudHomeMemoryError("unavailable");
    return await client.listMemory();
  }, [client]);
  const writeMemory = useCallback(
    async (input: CloudHomeMemoryWriteInput) => {
      if (!client || !identity) {
        throw new CloudHomeMemoryError("unavailable");
      }
      const attempt = beginCloudMemoryDocumentWrite({
        identity,
        ownerGeneration: input.ownerGeneration,
        memoryEpoch: input.memoryEpoch,
        document: input.document,
        content: input.content,
      });
      return await client.writeMemory(attempt);
    },
    [client, identity],
  );
  return {
    identity,
    lifecycle,
    available: Boolean(client && lifecycle?.state === "open"),
    loading: Boolean(
      identity && (configResult === undefined || lifecycleResult === undefined),
    ),
    unavailable: Boolean(
      identity &&
      configResult !== undefined &&
      lifecycleResult !== undefined &&
      (!client || !lifecycle),
    ),
    listMemory,
    writeMemory,
  };
};
