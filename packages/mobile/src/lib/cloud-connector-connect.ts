import { makeFunctionReference } from "convex/server";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import * as Crypto from "expo-crypto";
import { useCallback, useMemo } from "react";
import { authClient } from "./auth-client";

/**
 * Pending inline connect cards for the signed-in account: what a cloud
 * orchestrator turn is waiting on while its `connector_status` call holds.
 * Same subscription shape as cloud browser interactions.
 */

export type CloudConnectorConnectState =
  | "pending"
  | "connecting"
  | "connected"
  | "declined"
  | "canceled"
  | "expired";

export type CloudConnectorConnectRequest = Readonly<{
  schemaVersion: 1;
  requestId: string;
  conversationId: string;
  turnId: string;
  integrationId: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  reason?: string;
  state: CloudConnectorConnectState;
  revision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}>;

const listRef = makeFunctionReference<
  "query",
  Record<string, never>,
  CloudConnectorConnectRequest[]
>("cloud_connector_connect:listMyPendingConnectRequests");
const decideRef = makeFunctionReference<
  "action",
  {
    requestId: string;
    expectedRevision: number;
    decisionRequestId: string;
    decision: "connect" | "decline";
  },
  { request: CloudConnectorConnectRequest; url?: string }
>("cloud_connector_connect:decideMyConnectRequest");

const EMPTY: readonly CloudConnectorConnectRequest[] = [];
const decisionRequestIds = new Map<string, string>();

/**
 * Connect cards are a connected-account feature: the query refuses the
 * anonymous owner, so gate the subscription the way cloud browser does.
 */
const useConnectedAccountAccess = (): boolean => {
  const { isAuthenticated } = useConvexAuth();
  const session = authClient.useSession();
  const hasConnectedAccount =
    Boolean(session.data) && session.data?.user?.isAnonymous !== true;
  return isAuthenticated && hasConnectedAccount;
};

export function usePendingCloudConnectRequests(): readonly CloudConnectorConnectRequest[] {
  const enabled = useConnectedAccountAccess();
  return useQuery(listRef, enabled ? {} : "skip") ?? EMPTY;
}

export function useCurrentConversationConnectRequest(
  conversationId: string | null | undefined,
): CloudConnectorConnectRequest | null {
  const requests = usePendingCloudConnectRequests();
  return useMemo(
    () =>
      requests
        .filter((entry) => entry.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
    [conversationId, requests],
  );
}

export function useCloudConnectRequestActions() {
  const decideAction = useAction(decideRef);
  const decide = useCallback(
    async (args: {
      requestId: string;
      expectedRevision: number;
      decision: "connect" | "decline";
    }) => {
      const key = `${args.requestId}:${args.expectedRevision}:${args.decision}`;
      const decisionRequestId =
        decisionRequestIds.get(key) ?? Crypto.randomUUID();
      decisionRequestIds.set(key, decisionRequestId);
      try {
        return await decideAction({ ...args, decisionRequestId });
      } finally {
        decisionRequestIds.delete(key);
      }
    },
    [decideAction],
  );
  return { decide };
}
