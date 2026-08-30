import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import type {
  CloudBrowserInteractionDecision,
  CloudBrowserInteractionDetail,
  CloudBrowserInteractionSummary,
} from "@stella/contracts/cloud-browser";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { cloudBrowserApi } from "./cloud-browser-api";

const EMPTY_INTERACTIONS: readonly CloudBrowserInteractionSummary[] = [];
const decisionRequestIds = new Map<string, string>();
let resetRequestId: string | null = null;

const newRequestId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function usePendingCloudBrowserInteractions(): readonly CloudBrowserInteractionSummary[] {
  const { isAuthenticated } = useConvexAuth();
  const { hasConnectedAccount } = useAuthSessionState();
  const interactions = useQuery(
    cloudBrowserApi.listMyPendingBrowserInteractions,
    isAuthenticated && hasConnectedAccount ? {} : "skip",
  );
  return interactions ?? EMPTY_INTERACTIONS;
}

export function useCloudBrowserInteraction(
  interactionId: string | null | undefined,
): CloudBrowserInteractionDetail | null | undefined {
  const { isAuthenticated } = useConvexAuth();
  const pending = usePendingCloudBrowserInteractions();
  const revision = pending.find(
    (entry) => entry.interactionId === interactionId,
  )?.revision;
  const getInteraction = useAction(cloudBrowserApi.getMyBrowserInteraction);
  const requestKey =
    isAuthenticated && interactionId
      ? `${interactionId}:${revision ?? "direct"}`
      : null;
  const [result, setResult] = useState<{
    key: string;
    value: CloudBrowserInteractionDetail | null;
  } | null>(null);

  useEffect(() => {
    if (!requestKey || !interactionId) return;
    let disposed = false;
    void getInteraction({ interactionId })
      .then((value) => {
        if (!disposed) setResult({ key: requestKey, value });
      })
      .catch(() => {
        if (!disposed) setResult({ key: requestKey, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [getInteraction, interactionId, requestKey]);

  return result?.key === requestKey ? result.value : undefined;
}

export function useCurrentConversationBrowserInteraction(
  conversationId: string | null | undefined,
) {
  const interactions = usePendingCloudBrowserInteractions();
  const summary = useMemo(
    () =>
      interactions
        .filter((entry) => entry.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
    [conversationId, interactions],
  );
  const detail = useCloudBrowserInteraction(summary?.interactionId);
  return { summary, detail };
}

export function useCloudBrowserActions() {
  const mintLiveView = useAction(
    cloudBrowserApi.mintMyBrowserLiveViewCapability,
  );
  const decideAction = useAction(cloudBrowserApi.decideMyBrowserInteraction);
  const resetAction = useAction(cloudBrowserApi.resetMyBrowserProfile);
  const decide = useCallback(
    async (args: {
      interactionId: string;
      expectedRevision: number;
      decision: CloudBrowserInteractionDecision;
    }) => {
      const key = `${args.interactionId}:${args.expectedRevision}:${args.decision}`;
      const requestId = decisionRequestIds.get(key) ?? newRequestId();
      decisionRequestIds.set(key, requestId);
      const result = await decideAction({ ...args, requestId });
      decisionRequestIds.delete(key);
      return result;
    },
    [decideAction],
  );
  const resetProfile = useCallback(async () => {
    const requestId = resetRequestId ?? newRequestId();
    resetRequestId = requestId;
    const result = await resetAction({ requestId });
    resetRequestId = null;
    return result;
  }, [resetAction]);

  return {
    mintLiveView,
    decide,
    resetProfile,
  };
}
