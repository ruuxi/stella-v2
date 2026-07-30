import { useEffect } from "react";
import {
  getOrCreateLocalConversationId,
  isLocalChatApiAvailable,
} from "@/features/chat/services/local-chat-store";
import { useUiState } from "@/context/ui-state";
import {
  configurePiRuntime,
  getOrCreateDeviceId,
} from "@/platform/electron/device";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { useBootstrapState } from "./bootstrap-state";

const CONVERSATION_BOOTSTRAP_TIMEOUT_MS = 45_000;
const CONVERSATION_BOOTSTRAP_RETRY_MS = 350;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

export const useConversationBootstrap = () => {
  const { setConversationId } = useUiState();
  const { cloudMode, isLoading: isAuthLoading } = useCloudMode();
  const { bootstrapAttempt, markFailed, markPreparing, markReady } =
    useBootstrapState();

  useEffect(() => {
    if (isAuthLoading) return;

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

      const hostPromise = configurePiRuntime();
      const devicePromise = getOrCreateDeviceId();
      const settleRuntime = () =>
        Promise.allSettled([hostPromise, devicePromise]);
      const startedAt = Date.now();

      try {
        // Signed-in conversation identity is resolved from the cloud index by
        // the root route. Starting/restoring a local SQLite conversation here
        // would create a second desktop-only universe before that query wins
        // the race. Runtime/device setup still runs so local execution is
        // ready once the cloud route id is selected.
        if (cloudMode) {
          await settleRuntime();
          if (!cancelled) markReady();
          return;
        }

        while (!cancelled) {
          try {
            // Seed the durable active-conversation pointer (creating one on a
            // fresh install) and mirror it into UiState for callers that read
            // `state.conversationId` before the router resolves. We do NOT
            // navigate here: the `/chat` route loader is the single owner of
            // `?c=`, backfilling it from this same durable pointer. That keeps
            // one source of truth and avoids racing the route restore.
            const [localConversationId] = await Promise.all([
              getOrCreateLocalConversationId(),
              settleRuntime(),
            ]);

            if (cancelled) {
              return;
            }

            setConversationId(localConversationId);
            markReady();
            return;
          } catch (error) {
            if (Date.now() - startedAt >= CONVERSATION_BOOTSTRAP_TIMEOUT_MS) {
              throw error;
            }
            await wait(CONVERSATION_BOOTSTRAP_RETRY_MS);
          }
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        markFailed(
          error instanceof Error && error.message
            ? error.message
            : "Stella could not finish starting.",
        );
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    bootstrapAttempt,
    cloudMode,
    isAuthLoading,
    markFailed,
    markPreparing,
    markReady,
    setConversationId,
  ]);
};
