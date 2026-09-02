import { useEffect } from "react";
import {
  getOrCreateLocalConversationId,
  isLocalChatApiAvailable,
} from "@/features/chat/services/local-chat-store";
import {
  configurePiRuntime,
  getOrCreateDeviceId,
} from "@/platform/electron/device";
import { useBootstrapState } from "./bootstrap-state";

const CONVERSATION_BOOTSTRAP_TIMEOUT_MS = 45_000;
const CONVERSATION_BOOTSTRAP_RETRY_MS = 350;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

export const useConversationBootstrap = () => {
  const { bootstrapAttempt, markFailed, markPreparing, markReady } =
    useBootstrapState();

  useEffect(() => {
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
        while (!cancelled) {
          try {
            // Seed the durable local active-conversation pointer (creating one
            // on a fresh install) and settle the runtime host. This must NOT
            // write `UiState.conversationId`: the root layout is the single
            // selection authority and mirrors only the owner-checked cloud
            // conversation into UiState (see STATE_OWNERSHIP.md). Writing the
            // local id here made the root layout immediately reset it to null,
            // which the shell read as "runtime ready, no conversation" and
            // re-ran this bootstrap — a ~500 Hz render + IPC loop until the
            // cloud conversation resolved.
            await Promise.all([
              getOrCreateLocalConversationId(),
              settleRuntime(),
            ]);

            if (cancelled) {
              return;
            }

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
  }, [bootstrapAttempt, markFailed, markPreparing, markReady]);
};
