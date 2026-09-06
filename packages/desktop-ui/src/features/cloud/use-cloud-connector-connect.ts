/**
 * Pending inline connect cards for the signed-in account: what a cloud
 * orchestrator turn is waiting on while its `connector_status` call holds.
 * Same subscription shape as cloud browser interactions.
 */
import { useCallback, useMemo } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import type {
  CloudConnectorConnectDecision,
  CloudConnectorConnectRequest,
} from "@stella/contracts/cloud-connector-connect";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { cloudConnectorConnectApi } from "./cloud-connector-connect-api";

const EMPTY: readonly CloudConnectorConnectRequest[] = [];
const decisionRequestIds = new Map<string, string>();

const newRequestId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `connect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function usePendingCloudConnectRequests(): readonly CloudConnectorConnectRequest[] {
  const { isAuthenticated } = useConvexAuth();
  const { hasConnectedAccount } = useAuthSessionState();
  const requests = useQuery(
    cloudConnectorConnectApi.listMyPendingConnectRequests,
    isAuthenticated && hasConnectedAccount ? {} : "skip",
  );
  return requests ?? EMPTY;
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
  const decideAction = useAction(cloudConnectorConnectApi.decideMyConnectRequest);
  const decide = useCallback(
    async (args: {
      requestId: string;
      expectedRevision: number;
      decision: CloudConnectorConnectDecision;
    }) => {
      const key = `${args.requestId}:${args.expectedRevision}:${args.decision}`;
      const decisionRequestId = decisionRequestIds.get(key) ?? newRequestId();
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
