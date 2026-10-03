import { useCallback, useMemo } from "react";
import type { MemoryWipeStatus } from "@stella/contracts/backend/home";
import type {
  CloudMemoryDocument,
  CloudMemorySnapshot,
} from "@stella/contracts/cloud-home-sync";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import type { AuthSessionScopeData } from "@/global/auth/lib/auth-session-scope";
import { resolveAuthSessionCacheScope } from "@/global/auth/lib/auth-session-scope";
import { getAuthSessionSnapshot } from "@/global/auth/services/auth-session";
import { getConvexTokenForSubject } from "@/global/auth/services/auth-token";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { backendUrl } from "@/platform/backend/backend-client";
import { useBackendView } from "@/platform/backend/use-backend-view";
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
  lifecycle: MemoryWipeStatus | null;
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
  const {
    isCloudConversationReady,
    accountScope,
    identityRevision,
    ownerSubject,
  } = useCloudConversationSession();
  const identity = useMemo<CloudHomeMemoryClientIdentity | null>(() => {
    if (
      !isCloudConversationReady ||
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
    isCloudConversationReady,
    identityRevision,
    ownerSubject,
    session.cacheScope,
    session.identityRevision,
  ]);
  const live = useBackendView("memory.wipeStatus", identity ? {} : "skip");
  // A value echoing another owner is the previous account's; keep loading.
  const settled =
    live.status === "error" ||
    (live.status === "ready" &&
      live.value.subject === identity?.expectedSubject);
  const liveValue = live.status === "ready" ? live.value : undefined;
  const lifecycle = useMemo<MemoryWipeStatus | null>(() => {
    if (!identity || liveValue === undefined) return null;
    try {
      return decodeCloudMemoryWipeStatus(liveValue, identity.expectedSubject);
    } catch {
      return null;
    }
  }, [identity, liveValue]);
  const client = useMemo(() => {
    if (!identity || !backendUrl) return null;
    try {
      return createCloudHomeMemoryClient({
        builderOrigin: backendUrl,
        identity,
        getCurrentIdentity: identityFromCurrentSession,
        getTokenForSubject: readOwnerToken,
      });
    } catch {
      return null;
    }
  }, [identity]);
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
    loading: Boolean(identity && !settled),
    unavailable: Boolean(identity && settled && (!client || !lifecycle)),
    listMemory,
    writeMemory,
  };
};
