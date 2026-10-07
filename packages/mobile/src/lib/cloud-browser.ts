import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useMemo, useState } from "react";
import { authClient } from "./auth-client";
import { getBackendClient, useBackendView } from "./backend";
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

const EMPTY_INTERACTIONS: readonly CloudBrowserInteractionSummary[] = [];
const decisionRequestIds = new Map<string, string>();
let resetRequestId: string | null = null;

const newRequestId = (): string => Crypto.randomUUID();

/**
 * The cloud browser is a connected-account feature: every `browser.*`
 * backend function refuses the Better Auth anonymous owner, so hold off until
 * the session is a connected account. Mirrors desktop's
 * `hasConnectedAccount` gate.
 */
const useCloudBrowserAccess = (): boolean => {
  const session = authClient.useSession();
  return Boolean(session.data) && session.data?.user?.isAnonymous !== true;
};

export function usePendingCloudBrowserInteractions(): readonly CloudBrowserInteractionSummary[] {
  const enabled = useCloudBrowserAccess();
  return (
    useBackendView("browser.pending", enabled ? {} : "skip").value ??
    EMPTY_INTERACTIONS
  );
}

export function useCloudBrowserInteraction(
  interactionId: string | null | undefined,
): CloudBrowserInteractionDetail | null | undefined {
  const enabled = useCloudBrowserAccess();
  const pending = usePendingCloudBrowserInteractions();
  const revision = pending.find(
    (entry) => entry.interactionId === interactionId,
  )?.revision;
  const key =
    enabled && interactionId
      ? `${interactionId}:${revision ?? "direct"}`
      : null;
  const [result, setResult] = useState<{
    key: string;
    value: CloudBrowserInteractionDetail | null;
  } | null>(null);

  useEffect(() => {
    if (!key || !interactionId) return;
    let disposed = false;
    void getBackendClient()
      .call("browser.detail", { interactionId })
      .then((value) => {
        if (!disposed) setResult({ key, value });
      })
      .catch(() => {
        if (!disposed) setResult({ key, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [interactionId, key]);

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
  const mintLiveView = useCallback(
    (args: { interactionId: string; expectedRevision: number }) =>
      getBackendClient().call("browser.liveView", args),
    [],
  );
  const mintSessionTransfer = useCallback(
    (args: { interactionId: string; expectedRevision: number }) =>
      getBackendClient().call("browser.sessionTransferKey", args),
    [],
  );
  const importSessionTransfer = useCallback(
    (args: {
      interactionId: string;
      expectedRevision: number;
      transfer: CloudBrowserEncryptedSessionTransfer;
    }) => getBackendClient().call("browser.importSessionTransfer", args),
    [],
  );
  const decide = useCallback(
    async (args: {
      interactionId: string;
      expectedRevision: number;
      decision: "done" | "cancel";
    }) => {
      const key = `${args.interactionId}:${args.expectedRevision}:${args.decision}`;
      const requestId = decisionRequestIds.get(key) ?? newRequestId();
      decisionRequestIds.set(key, requestId);
      const result = await getBackendClient().call("browser.decide", {
        ...args,
        requestId,
      });
      decisionRequestIds.delete(key);
      return result;
    },
    [],
  );
  const resetProfile = useCallback(async () => {
    const requestId = resetRequestId ?? newRequestId();
    resetRequestId = requestId;
    const result = await getBackendClient().call("browser.resetProfile", {
      requestId,
    });
    resetRequestId = null;
    return result;
  }, []);
  return {
    mintLiveView,
    mintSessionTransfer,
    importSessionTransfer,
    decide,
    resetProfile,
  };
}
