import { useLayoutEffect } from "react";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { mirrorCloudMemoryPreferenceLocally } from "./cloud-memory-local-mirror";
import { useCloudMemoryPreference } from "./use-cloud-memory-preference";

function AccountMemoryPreferenceBridge() {
  const preference = useCloudMemoryPreference();
  const desired =
    preference.status === "synced" && preference.preference
      ? preference.preference.memoryEnabled
      : false;

  // A new account/session and every authority loss begin fail-closed. Never
  // enable the local runtime until that false write is acknowledged, and keep
  // retrying a rejected/false echo instead of leaving the prior owner enabled.
  useLayoutEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = null;
        void apply();
      }, 1_000);
    };
    const apply = async () => {
      const failClosed = await mirrorCloudMemoryPreferenceLocally(false).catch(
        () => false,
      );
      if (cancelled) return;
      if (!failClosed) {
        scheduleRetry();
        return;
      }
      if (!desired) return;
      const mirrored = await mirrorCloudMemoryPreferenceLocally(true).catch(
        () => false,
      );
      if (!cancelled && !mirrored) scheduleRetry();
    };

    void apply();
    return () => {
      cancelled = true;
      if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
    };
  }, [desired]);

  return null;
}

/** Keeps the local desktop runtime a rebuildable mirror of cloud authority. */
export function CloudMemoryPreferenceBridge() {
  const mode = useCloudConversationSession();
  const key = mode.isCloudConversationReady
    ? `${mode.accountScope}:${mode.identityRevision}:${mode.ownerSubject ?? "missing"}`
    : `unavailable:${mode.accountScope}:${mode.identityRevision}`;
  return <AccountMemoryPreferenceBridge key={key} />;
}
