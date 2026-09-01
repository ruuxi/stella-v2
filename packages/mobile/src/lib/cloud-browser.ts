import { makeFunctionReference } from "convex/server";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useMemo, useState } from "react";
import { selectCurrentConversationBrowserInteraction } from "./cloud-browser-interaction-selection";

export type CloudBrowserInteractionKind = "login_takeover" | "device_code";
export type CloudBrowserInteractionState =
  | "pending"
  | "human_control"
  | "resuming"
  | "completed"
  | "canceled"
  | "expired"
  | "failed";

export type CloudBrowserInteractionSummary = Readonly<{
  schemaVersion: 1;
  interactionId: string;
  conversationId: string;
  threadId: string;
  turnId: string;
  kind: CloudBrowserInteractionKind;
  state: CloudBrowserInteractionState;
  displayOrigin: string;
  displayTitle?: string;
  revision: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}>;

export type CloudBrowserInteractionDetail =
  | (CloudBrowserInteractionSummary & {
      kind: "login_takeover";
      loginUrl: string;
    })
  | (CloudBrowserInteractionSummary & {
      kind: "device_code";
      verificationUri: string;
      verificationUriComplete?: string;
      userCode: string;
    });

export type CloudBrowserLiveViewCapability = Readonly<{
  schemaVersion: 1;
  interactionId: string;
  revision: number;
  url: string;
  expiresAt: number;
}>;

export type CloudBrowserSessionTransferCapability = Readonly<{
  schemaVersion: 1;
  algorithm: "x25519-hkdf-sha256-aes-256-gcm-v1";
  capabilityId: string;
  interactionId: string;
  revision: number;
  publicKey: string;
  expiresAt: number;
}>;

export type CloudBrowserEncryptedSessionTransfer = Readonly<{
  schemaVersion: 1;
  algorithm: "x25519-hkdf-sha256-aes-256-gcm-v1";
  capabilityId: string;
  clientPublicKey: string;
  iv: string;
  ciphertext: string;
}>;

const listRef = makeFunctionReference<
  "query",
  Record<string, never>,
  CloudBrowserInteractionSummary[]
>("cloud_browser:listMyPendingBrowserInteractions");
const detailRef = makeFunctionReference<
  "action",
  { interactionId: string },
  CloudBrowserInteractionDetail | null
>("cloud_browser:getMyBrowserInteraction");
const mintRef = makeFunctionReference<
  "action",
  { interactionId: string; expectedRevision: number },
  CloudBrowserLiveViewCapability
>("cloud_browser:mintMyBrowserLiveViewCapability");
const mintSessionTransferRef = makeFunctionReference<
  "action",
  { interactionId: string; expectedRevision: number },
  CloudBrowserSessionTransferCapability
>("cloud_browser:mintMyBrowserSessionTransferCapability");
const importSessionTransferRef = makeFunctionReference<
  "action",
  {
    interactionId: string;
    expectedRevision: number;
    transfer: CloudBrowserEncryptedSessionTransfer;
  },
  {
    schemaVersion: 1;
    interactionId: string;
    revision: number;
    verified: true;
  }
>("cloud_browser:importMyBrowserSessionTransfer");
const decideRef = makeFunctionReference<
  "action",
  {
    interactionId: string;
    expectedRevision: number;
    requestId: string;
    decision: "done" | "cancel";
  },
  CloudBrowserInteractionSummary
>("cloud_browser:decideMyBrowserInteraction");
const resetRef = makeFunctionReference<
  "action",
  { requestId: string },
  {
    schemaVersion: 1;
    profileId: "default";
    profileEpoch: number;
    reset: true;
  }
>("cloud_browser:resetMyBrowserProfile");

const EMPTY_INTERACTIONS: readonly CloudBrowserInteractionSummary[] = [];
const decisionRequestIds = new Map<string, string>();
let resetRequestId: string | null = null;

const newRequestId = (): string => Crypto.randomUUID();

export function usePendingCloudBrowserInteractions(): readonly CloudBrowserInteractionSummary[] {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(listRef, isAuthenticated ? {} : "skip") ?? EMPTY_INTERACTIONS;
}

export function useCloudBrowserInteraction(
  interactionId: string | null | undefined,
): CloudBrowserInteractionDetail | null | undefined {
  const { isAuthenticated } = useConvexAuth();
  const pending = usePendingCloudBrowserInteractions();
  const revision = pending.find(
    (entry) => entry.interactionId === interactionId,
  )?.revision;
  const getDetail = useAction(detailRef);
  const key =
    isAuthenticated && interactionId
      ? `${interactionId}:${revision ?? "direct"}`
      : null;
  const [result, setResult] = useState<{
    key: string;
    value: CloudBrowserInteractionDetail | null;
  } | null>(null);

  useEffect(() => {
    if (!key || !interactionId) return;
    let disposed = false;
    void getDetail({ interactionId })
      .then((value) => {
        if (!disposed) setResult({ key, value });
      })
      .catch(() => {
        if (!disposed) setResult({ key, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [getDetail, interactionId, key]);

  return result?.key === key ? result.value : undefined;
}

export function useCurrentConversationBrowserInteraction(
  conversationId: string | null | undefined,
) {
  const interactions = usePendingCloudBrowserInteractions();
  const summary = useMemo(
    () =>
      selectCurrentConversationBrowserInteraction(
        interactions,
        conversationId,
      ),
    [conversationId, interactions],
  );
  // Once the interaction is resuming, the card no longer renders any controls
  // that need private detail. Avoid racing a final status fetch against the
  // gateway's revision change after the user's decision.
  const detail = useCloudBrowserInteraction(
    summary?.state === "resuming" ? null : summary?.interactionId,
  );
  return { summary, detail };
}

export function useCloudBrowserActions() {
  const mintLiveView = useAction(mintRef);
  const decideAction = useAction(decideRef);
  const mintSessionTransfer = useAction(mintSessionTransferRef);
  const importSessionTransfer = useAction(importSessionTransferRef);
  const resetAction = useAction(resetRef);
  const decide = useCallback(
    async (args: {
      interactionId: string;
      expectedRevision: number;
      decision: "done" | "cancel";
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
    mintSessionTransfer,
    importSessionTransfer,
    decide,
    resetProfile,
  };
}
