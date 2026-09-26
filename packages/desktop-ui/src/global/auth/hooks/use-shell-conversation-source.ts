import {
  useConvexAuth,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import { useMemo, useState } from "react";
import {
  cloudApi,
  type CloudOwnershipMigrationStatus,
  type CloudShellBootstrap,
} from "@/features/cloud/cloud-api";
import { readActiveCloudConversationIdCache } from "@/features/cloud/cloud-conversation-cache";
import {
  cloudConversationsForOwnerSubject,
  isOwnedCloudConversation,
} from "@/features/cloud/cloud-conversation-selection";
import {
  readPrefetchedOwnershipMigration,
  resolveCloudConversationSession,
  resolveOwnershipMigrationGate,
} from "../lib/cloud-conversation-session";
import {
  captureShellBootstrapLookups,
  isMissingPublicFunctionError,
  readShellBootstrap,
  readShellBootstrapLookup,
  type ShellBootstrapLookups,
} from "../lib/cloud-shell-bootstrap";
import type { useCloudConversationSession } from "./use-cloud-conversation-session";

type CloudConversationSession = ReturnType<typeof useCloudConversationSession>;

/**
 * Every Convex read the root shell makes to select a conversation.
 *
 * One reactive query, `cloud_apps:getMyShellBootstrap`, proves the session
 * identity itself and answers the migration status, the recent-conversation
 * list, the owner generation and the route/cached ownership lookups
 * together, so the shell selects a conversation one round trip after Convex
 * auth. Other surfaces keep their own `confirmMySessionIdentity` readiness;
 * the shell's readiness comes from the bootstrap alone.
 *
 * Against a backend that does not serve the bootstrap yet it falls back, for
 * the rest of this run, to the chain it replaces (see `usesLegacyChain`).
 */
export function useShellConversationSource({
  session,
  isPrivate,
  routeConversationId,
}: {
  session: CloudConversationSession;
  isPrivate: boolean;
  /** `?c=` on the chat route, else null. */
  routeConversationId: string | null;
}) {
  const { accountScope, expectedSubject, ownerSubject, identityRevision } =
    session;
  const { isAuthenticated: convexIsAuthenticated } = useConvexAuth();
  // TEMPORARY fallback (remove with `isMissingPublicFunctionError`): set once
  // the backend reports the bootstrap query missing.
  const [bootstrapUnavailable, setBootstrapUnavailable] = useState(false);
  // `ownerSubject` is also null while the session is still loading; only a
  // loaded subject without an owner id (no configured token issuer) means the
  // bootstrap cannot be asked.
  const usesLegacyChain =
    isPrivate ||
    bootstrapUnavailable ||
    (expectedSubject !== null && ownerSubject === null);

  const lookupKey =
    !usesLegacyChain && session.canConfirmIdentity && expectedSubject
      ? `${accountScope}\u0000${ownerSubject}\u0000${identityRevision}`
      : null;
  const [capturedLookups, setCapturedLookups] =
    useState<ShellBootstrapLookups | null>(null);
  if (lookupKey !== null && capturedLookups?.key !== lookupKey) {
    setCapturedLookups(
      captureShellBootstrapLookups(
        lookupKey,
        routeConversationId,
        readActiveCloudConversationIdCache(accountScope),
      ),
    );
  }
  const lookups =
    lookupKey !== null && capturedLookups?.key === lookupKey
      ? capturedLookups
      : null;

  const request = useMemo<RequestForQueries>(() => {
    const queries: RequestForQueries = {};
    if (lookups && expectedSubject && ownerSubject) {
      queries.bootstrap = {
        query: cloudApi.getMyShellBootstrap,
        args: {
          expectedSubject,
          expectedOwnerId: ownerSubject,
          identityRevision,
          ...(lookups.routeConversationId
            ? { routeConversationId: lookups.routeConversationId }
            : {}),
          ...(lookups.cachedConversationId
            ? { cachedConversationId: lookups.cachedConversationId }
            : {}),
        },
      };
    } else if (usesLegacyChain && !isPrivate && convexIsAuthenticated) {
      // Legacy chain: prefetch the migration status in parallel with the
      // session identity confirmation (exposed only once confirmed).
      queries.migration = {
        query: cloudApi.getMyOwnershipMigrationStatus,
        args: {},
      };
    }
    return queries;
  }, [
    convexIsAuthenticated,
    expectedSubject,
    identityRevision,
    isPrivate,
    lookups,
    ownerSubject,
    usesLegacyChain,
  ]);
  const results = useQueries(request);
  const bootstrapResult = results.bootstrap as
    | CloudShellBootstrap
    | Error
    | undefined;
  if (!bootstrapUnavailable && isMissingPublicFunctionError(bootstrapResult)) {
    setBootstrapUnavailable(true);
  }
  const bootstrap = usesLegacyChain
    ? null
    : readShellBootstrap(bootstrapResult, ownerSubject);
  const ready = bootstrap?.ready ?? null;

  const mode = bootstrap
    ? resolveCloudConversationSession({
        ...session.sessionGate,
        identityConfirmed: ready !== null,
        identityIsLoading: session.canConfirmIdentity && !bootstrap.settled,
      })
    : {
        isCloudConversationReady: session.isCloudConversationReady,
        isLoading: session.isLoading,
      };
  const isCloudConversationReady = !isPrivate && mode.isCloudConversationReady;
  const ownershipMigration = readPrefetchedOwnershipMigration<
    CloudOwnershipMigrationStatus
  >(
    bootstrap
      ? ready?.migration
      : (results.migration as CloudOwnershipMigrationStatus | Error | undefined),
    isCloudConversationReady,
  );
  const ownershipMigrationGate = resolveOwnershipMigrationGate(
    ownershipMigration === undefined
      ? undefined
      : (ownershipMigration?.status ?? null),
    isCloudConversationReady,
  );
  const canQueryOwnershipFencedCloudData =
    !isPrivate && ownershipMigrationGate.canSelectConversation;
  const selection =
    bootstrap && canQueryOwnershipFencedCloudData
      ? (ready?.selection ?? undefined)
      : undefined;

  const legacyFenced = usesLegacyChain && canQueryOwnershipFencedCloudData;
  const legacyConversations = useQuery(
    cloudApi.listMyConversations,
    legacyFenced ? {} : "skip",
  );
  const legacyConversationIdentity = useQuery(
    cloudApi.getMyCloudConversationIdentity,
    legacyFenced ? {} : "skip",
  );
  const cloudConversations = bootstrap
    ? selection?.conversations
    : legacyConversations;
  const conversationIdentity = bootstrap
    ? selection && ready
      ? { ownerId: ready.ownerId, ownerGeneration: selection.ownerGeneration }
      : undefined
    : legacyConversationIdentity;
  const ownerGeneration =
    conversationIdentity?.ownerId === ownerSubject
      ? conversationIdentity.ownerGeneration
      : null;

  const scopedCloudConversations = useMemo(
    () =>
      cloudConversationsForOwnerSubject(cloudConversations ?? [], ownerSubject),
    [cloudConversations, ownerSubject],
  );
  const cachedCloudConversationId = isCloudConversationReady
    ? readActiveCloudConversationIdCache(accountScope)
    : null;
  const routeIsListedOrPendingCloudConversation = isOwnedCloudConversation(
    scopedCloudConversations,
    routeConversationId,
    accountScope,
    ownerSubject,
  );
  const routeLookupId =
    canQueryOwnershipFencedCloudData &&
    routeConversationId &&
    !routeIsListedOrPendingCloudConversation
      ? routeConversationId
      : null;
  const launchRouteConversation = routeLookupId
    ? readShellBootstrapLookup(selection, lookups, routeLookupId)
    : undefined;
  const queriedRouteConversation = useQuery(
    cloudApi.getMyConversation,
    routeLookupId && launchRouteConversation === undefined
      ? { conversationId: routeLookupId }
      : "skip",
  );
  const exactCloudConversation =
    launchRouteConversation !== undefined
      ? launchRouteConversation
      : queriedRouteConversation;
  const cachedConversationIsListed = Boolean(
    cachedCloudConversationId &&
      scopedCloudConversations.some(
        (conversation) =>
          conversation.conversationId === cachedCloudConversationId,
      ),
  );
  const cachedLookupId =
    canQueryOwnershipFencedCloudData &&
    cachedCloudConversationId &&
    cachedCloudConversationId !== routeConversationId &&
    !cachedConversationIsListed
      ? cachedCloudConversationId
      : null;
  const launchCachedConversation = cachedLookupId
    ? readShellBootstrapLookup(selection, lookups, cachedLookupId)
    : undefined;
  const queriedCachedConversation = useQuery(
    cloudApi.getMyConversation,
    cachedLookupId && launchCachedConversation === undefined
      ? { conversationId: cachedLookupId }
      : "skip",
  );
  const exactCachedCloudConversation =
    launchCachedConversation !== undefined
      ? launchCachedConversation
      : queriedCachedConversation;

  return {
    isCloudConversationReady,
    isLoading: mode.isLoading,
    ownershipMigration,
    ownershipMigrationGate,
    cloudConversations,
    scopedCloudConversations,
    ownerGeneration,
    cachedCloudConversationId,
    routeIsListedOrPendingCloudConversation,
    exactCloudConversation,
    cachedConversationIsListed,
    exactCachedCloudConversation,
  };
}
