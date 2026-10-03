import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { CloudSkillHead } from "@stella/contracts/cloud-home-sync";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { getConvexTokenForSubject } from "@/global/auth/services/auth-token";
import { backendClient, backendUrl } from "@/platform/backend/backend-client";
import { uiState } from "@/platform/ui-state";
import {
  cloudHomeSyncRetryStore,
  cloudHomeSyncStatusStore,
  runCloudHomeSync,
} from "./cloud-home-sync";

const unavailable = (accountScope: string, message: string) =>
  cloudHomeSyncStatusStore.set({
    accountScope,
    phase: "unavailable",
    memoryUploaded: 0,
    memoryCloudWins: 0,
    skillsUploaded: 0,
    skillsCloudWins: 0,
    skipped: 0,
    warnings: [],
    issues: [{ code: "not_available", message }],
  });

const SKILL_HEADS_TIMEOUT_MS = 20_000;

/**
 * One fresh read of the `skills.heads` view: subscribe, take the first value
 * the owner object computes, unsubscribe. The sync diffs against a snapshot
 * and re-reads after each upload, so it never holds the subscription open.
 */
const readSkillHeadsOnce = (
  clientScope: string,
  signal: AbortSignal,
): Promise<CloudSkillHead[]> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      stop?.();
      finish();
    };
    const onAbort = () =>
      settle(() => reject(new Error("Cloud Home sync was interrupted.")));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => settle(() => reject(new Error("Cloud skills did not load."))),
      SKILL_HEADS_TIMEOUT_MS,
    );
    stop = backendClient.watch(
      "skills.heads",
      { clientScope },
      (heads) => settle(() => resolve(heads)),
      (error) => settle(() => reject(error)),
    );
    // `watch` delivers an already-cached value synchronously.
    if (settled) stop();
  });

/**
 * Passive startup bridge that mirrors this Mac's Cloud Home root into the
 * cloud. Existing divergent cloud heads are never overwritten, and a skill the
 * root has dropped is tombstoned so cloud turns stop loading it; a settings
 * status card exposes conflicts and lets the user retry transient failures.
 */
export function CloudHomeSyncBridge() {
  const {
    isCloudConversationReady,
    accountScope,
    identityRevision,
    ownerSubject,
  } = useCloudConversationSession();
  const retry = useSyncExternalStore(
    cloudHomeSyncRetryStore.subscribe,
    cloudHomeSyncRetryStore.getSnapshot,
    cloudHomeSyncRetryStore.getServerSnapshot,
  );
  const identityKey = `${accountScope}:${identityRevision}:${ownerSubject ?? "missing"}`;
  const activeIdentityRef = useRef(identityKey);

  // Clear the old owner's labels before the browser can paint a transition
  // frame. AccountTab independently filters by scope as defense in depth.
  useLayoutEffect(() => {
    activeIdentityRef.current = identityKey;
    cloudHomeSyncStatusStore.reset(
      isCloudConversationReady ? accountScope : null,
    );
  }, [accountScope, isCloudConversationReady, identityKey]);

  useEffect(() => {
    if (!isCloudConversationReady) {
      cloudHomeSyncStatusStore.reset(null);
      return;
    }
    const cloudHome = window.electronAPI?.cloudHome;
    if (!cloudHome) {
      unavailable(
        accountScope,
        "Local Cloud Home import is available in the Stella desktop app.",
      );
      return;
    }
    if (!backendUrl) {
      unavailable(
        accountScope,
        "Cloud Home is not available in this deployment.",
      );
      return;
    }

    const controller = new AbortController();
    const scopeAtStart = accountScope;
    const identityAtStart = identityKey;
    void (async () => {
      const token = ownerSubject
        ? await getConvexTokenForSubject(ownerSubject)
        : null;
      if (
        controller.signal.aborted ||
        activeIdentityRef.current !== identityAtStart
      ) {
        return;
      }
      if (!token) {
        unavailable(scopeAtStart, "Sign in again to synchronize Cloud Home.");
        return;
      }
      await runCloudHomeSync({
        accountScope: scopeAtStart,
        expectedSubject: ownerSubject!,
        builderOrigin: backendUrl,
        token,
        scanLocal: () => cloudHome.scanLocal(scopeAtStart),
        readImportOwnership: cloudHome.getImportOwnership,
        readSkillHeads: () =>
          readSkillHeadsOnce(scopeAtStart, controller.signal),
        deleteSkillMirror: ({ slug, expectedRevision }) =>
          backendClient.call("skills.deleteMirrored", {
            clientScope: scopeAtStart,
            slug,
            expectedRevision,
          }),
        cursorStore: uiState,
        signal: controller.signal,
        onStatus: (status) => {
          if (
            !controller.signal.aborted &&
            activeIdentityRef.current === identityAtStart
          ) {
            cloudHomeSyncStatusStore.set(status);
          }
        },
      });
    })().catch(() => {
      if (
        !controller.signal.aborted &&
        activeIdentityRef.current === identityAtStart
      ) {
        unavailable(
          scopeAtStart,
          "Cloud Home could not be synchronized. Try again.",
        );
      }
    });
    return () => controller.abort();
  }, [
    accountScope,
    isCloudConversationReady,
    identityKey,
    ownerSubject,
    retry,
  ]);

  return null;
}
