import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import type {
  CloudBrowserInteractionDecision,
  CloudBrowserInteractionDetail,
  CloudBrowserInteractionSummary,
} from "@stella/contracts/cloud-browser";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useBackendValue } from "@/platform/backend/use-backend-view";
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
  const interactions = useBackendValue(
    "browser.pending",
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
    void cloudBrowserApi
      .getInteraction({ interactionId })
      .then((value) => {
        if (!disposed) setResult({ key: requestKey, value });
      })
      .catch(() => {
        if (!disposed) setResult({ key: requestKey, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [interactionId, requestKey]);

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
  const mintLiveView = cloudBrowserApi.mintLiveView;
  const decide = useCallback(
    async (args: {
      interactionId: string;
      expectedRevision: number;
      decision: CloudBrowserInteractionDecision;
    }) => {
      const key = `${args.interactionId}:${args.expectedRevision}:${args.decision}`;
      const requestId = decisionRequestIds.get(key) ?? newRequestId();
      decisionRequestIds.set(key, requestId);
      const result = await cloudBrowserApi.decide({ ...args, requestId });
      decisionRequestIds.delete(key);
      return result;
    },
    [],
  );
  const resetProfile = useCallback(async () => {
    const requestId = resetRequestId ?? newRequestId();
    resetRequestId = requestId;
    const result = await cloudBrowserApi.resetProfile({ requestId });
    resetRequestId = null;
    return result;
  }, []);

  return {
    mintLiveView,
    decide,
    resetProfile,
  };
}
