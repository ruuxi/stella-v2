import * as Crypto from "expo-crypto";
import { useCallback, useMemo } from "react";
import type { CloudConnectorConnectRequest } from "@stella/contracts/cloud-connector-connect";
import { authClient } from "./auth-client";
import { getBackendClient, useBackendView } from "./backend";

export type {
  CloudConnectorConnectRequest,
  CloudConnectorConnectState,
} from "@stella/contracts/cloud-connector-connect";

/**
 * Pending inline connect cards for the signed-in account: what a cloud
 * orchestrator turn is waiting on while its `connector_status` call holds.
 * Watched through the backend's `connect.pending` view.
 */

const EMPTY: readonly CloudConnectorConnectRequest[] = [];
const decisionRequestIds = new Map<string, string>();

/** Connect cards are a connected-account feature; anonymous owners skip. */
const useConnectedAccountAccess = (): boolean => {
  const session = authClient.useSession();
  return Boolean(session.data) && session.data?.user?.isAnonymous !== true;
};

export function usePendingCloudConnectRequests(): readonly CloudConnectorConnectRequest[] {
  const enabled = useConnectedAccountAccess();
  return useBackendView("connect.pending", enabled ? {} : "skip").value ?? EMPTY;
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
        return await getBackendClient().call("connect.decide", {
          ...args,
          decisionRequestId,
        });
      } finally {
        decisionRequestIds.delete(key);
      }
    },
    [],
  );
  return { decide };
}
