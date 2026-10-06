import { useCallback, useEffect, useRef, useState } from "react";
import { backendClient } from "@/platform/backend/backend-client";
import { openExternalUrl } from "@/platform/electron/open-external";

/**
 * Signing the owner's cloud in to ChatGPT (Sign in with ChatGPT; the cloud
 * is its own host). Claude sign-in is Claude Code's own and lives in
 * `features/claude/use-claude-login`.
 *
 * In the desktop app Electron main runs the browser round trip and catches
 * the 127.0.0.1 redirect on its loopback listener; this window only waits.
 * The redirect URL goes to the server, which exchanges the code and keeps
 * the cloud's credentials. In a browser nothing can listen on 127.0.0.1, so
 * the authorization page opens and the user pastes back the address the
 * browser landed on.
 */

export type EngineConnectFlow =
  | { kind: "browser"; provider: "chatgpt" }
  | {
      kind: "paste";
      provider: "chatgpt";
      connectId: string;
      authorizeUrl: string;
    };

export type EngineConnectOptions = {
  /** Sign a saved cloud ChatGPT account in again. */
  accountId?: string;
  /** Reuse a registration another of the owner's hosts made. */
  clientId?: string;
  /** Ask ChatGPT for consent to use the plan after it was declined. */
  enablePlanUsage?: boolean;
};

const messageOf = (error: unknown): string | null =>
  error instanceof Error && error.message ? error.message : null;

export function useEngineConnect() {
  const [flow, setFlow] = useState<EngineConnectFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settleRef = useRef<((outcome: boolean | Error) => void) | null>(null);
  const flowRef = useRef<EngineConnectFlow | null>(null);
  flowRef.current = flow;

  /** End the flow: connected, cancelled, or failed (`start` rejects). */
  const settle = useCallback((outcome: boolean | Error) => {
    flowRef.current = null;
    setFlow(null);
    setBusy(false);
    const done = settleRef.current;
    settleRef.current = null;
    done?.(outcome);
  }, []);

  const cancel = useCallback(() => {
    const current = flowRef.current;
    if (current?.kind === "paste") {
      void backendClient
        .call("engines.cancelConnect", { connectId: current.connectId })
        .catch(() => undefined);
    } else if (current) {
      void window.electronAPI?.system?.cancelChatGptCloudConnect?.().catch(() => undefined);
    }
    setError(null);
    settle(false);
  }, [settle]);

  /** Wait for the desktop app's own browser round trip to finish. */
  const runInMain = useCallback(
    (run: () => Promise<unknown>): Promise<boolean> => {
      const next: EngineConnectFlow = { kind: "browser", provider: "chatgpt" };
      flowRef.current = next;
      setFlow(next);
      return new Promise<boolean>((resolve, reject) => {
        settleRef.current = (outcome) =>
          outcome instanceof Error ? reject(outcome) : resolve(outcome);
        run().then(
          () => {
            if (flowRef.current === next) settle(true);
          },
          (caught: unknown) => {
            if (flowRef.current !== next) return;
            const message = messageOf(caught);
            if (message && /cancel/iu.test(message)) {
              settle(false);
              return;
            }
            settle(new Error(message ?? "That didn't connect. Try again."));
          },
        );
      });
    },
    [settle],
  );

  /**
   * Begin adding (or signing in again) a cloud ChatGPT account. Resolves
   * true once it is connected, false when cancelled; throws when the flow
   * could not start or the sign-in failed.
   */
  const start = useCallback(
    async (options: EngineConnectOptions = {}): Promise<boolean> => {
      if (flowRef.current) cancel();
      setError(null);
      const connectInMain = window.electronAPI?.system?.connectChatGptCloud;
      if (connectInMain) {
        return await runInMain(() => connectInMain(options));
      }
      setBusy(true);
      let next: EngineConnectFlow;
      try {
        const started = await backendClient.call("engines.startConnect", {
          provider: "chatgpt",
          ...(options.accountId ? { accountId: options.accountId } : {}),
          ...(options.clientId ? { clientId: options.clientId } : {}),
          ...(options.enablePlanUsage ? { enablePlanUsage: true } : {}),
        });
        next = {
          kind: "paste",
          provider: "chatgpt",
          connectId: started.connectId,
          authorizeUrl: started.authorizeUrl,
        };
      } finally {
        setBusy(false);
      }
      openExternalUrl(next.authorizeUrl);
      return await new Promise<boolean>((resolve, reject) => {
        settleRef.current = (outcome) =>
          outcome instanceof Error ? reject(outcome) : resolve(outcome);
        flowRef.current = next;
        setFlow(next);
      });
    },
    [cancel, runInMain],
  );

  /** In a browser: open the authorization page again. */
  const openAuthorizePage = useCallback(() => {
    const current = flowRef.current;
    if (current?.kind === "paste") openExternalUrl(current.authorizeUrl);
  }, []);

  /** In a browser: the address the browser landed on after approval. */
  const finish = useCallback(
    async (pasted: string) => {
      const current = flowRef.current;
      if (current?.kind !== "paste" || !pasted.trim()) return;
      setBusy(true);
      setError(null);
      try {
        await backendClient.call("engines.finishConnect", {
          connectId: current.connectId,
          pastedInput: pasted.trim(),
        });
        if (flowRef.current === current) settle(true);
      } catch (caught) {
        setBusy(false);
        setError(messageOf(caught) ?? "That didn't connect. Try again.");
      }
    },
    [settle],
  );

  // Leaving the surface abandons the attempt.
  useEffect(
    () => () => {
      const current = flowRef.current;
      if (current?.kind === "browser") {
        void window.electronAPI?.system?.cancelChatGptCloudConnect?.().catch(() => undefined);
      }
      settleRef.current?.(false);
    },
    [],
  );

  return { flow, busy, error, start, cancel, finish, openAuthorizePage };
}

export type EngineConnect = ReturnType<typeof useEngineConnect>;
