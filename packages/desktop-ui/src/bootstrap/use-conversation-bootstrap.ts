import { useEffect } from "react";
import { isLocalChatApiAvailable } from "@/features/chat/services/local-chat-store";
import {
  configurePiRuntime,
  getOrCreateDeviceId,
} from "@/platform/electron/device";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { useBootstrapState } from "./bootstrap-state";

export const useConversationBootstrap = () => {
  const {
    cloudMode,
    error: authError,
    isLoading: isAuthLoading,
  } = useCloudMode();
  const { bootstrapAttempt, markFailed, markPreparing, markReady } =
    useBootstrapState();

  useEffect(() => {
    if (authError) {
      markFailed(authError);
      return;
    }
    // There is no local-conversation fallback. The bootstrap surface remains
    // preparing until Better Auth has produced an anonymous or connected
    // session and Convex has accepted its token.
    if (isAuthLoading || !cloudMode) {
      markPreparing();
      return;
    }

    let cancelled = false;

    const run = async () => {
      markPreparing();

      // Plain-browser dev tab: there is no chat backend and never will be
      // this session — mark ready with no conversation instead of burning
      // the 45s retry loop into a bootstrap-failure surface.
      if (!isLocalChatApiAvailable()) {
        markReady();
        return;
      }

      // Conversation identity is resolved exclusively from the cloud index by
      // the root route. Runtime/device setup still runs so local execution and
      // its cache/outbox are ready once that cloud route id is selected.
      await Promise.allSettled([configurePiRuntime(), getOrCreateDeviceId()]);
      if (!cancelled) markReady();
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    authError,
    bootstrapAttempt,
    cloudMode,
    isAuthLoading,
    markFailed,
    markPreparing,
    markReady,
  ]);
};
