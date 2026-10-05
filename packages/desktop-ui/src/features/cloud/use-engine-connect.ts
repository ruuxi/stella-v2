import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineProvider } from "@stella/contracts/backend/engines";
import { backendClient } from "@/platform/backend/backend-client";
import { openExternalUrl } from "@/platform/electron/open-external";

/**
 * Adding an account to the owner's Stella account: a Claude subscription
 * (used on every computer and in the cloud), or a ChatGPT sign-in for the
 * owner's cloud (Sign in with ChatGPT; the cloud is its own host).
 *
 * In the desktop app Electron main runs the browser round trip and catches
 * the 127.0.0.1 redirect on its loopback listener; this window only waits.
 * Claude's tokens are exchanged there and uploaded; ChatGPT's redirect URL
 * goes to the server, which exchanges the code and keeps the credentials.
 * In a browser nothing can listen on 127.0.0.1, so ChatGPT sign-in opens
 * the authorization page and the user pastes back the address the browser
 * landed on; Claude sign-in needs the desktop app.
 */

export type EngineConnectFlow =
  | { kind: "browser"; provider: EngineProvider }
  | {
      kind: "paste";
      provider: "chatgpt";
      connectId: string;
      authorizeUrl: string;
    };

export type EngineConnectOptions = {
  /** Sign a saved cloud ChatGPT account in again. */
  accountId?: string;
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
    } else if (current?.provider === "anthropic") {
      void window.electronAPI?.system?.cancelClaudeAccountConnect?.().catch(() => undefined);
    } else if (current?.provider === "chatgpt") {
      void window.electronAPI?.system?.cancelChatGptCloudConnect?.().catch(() => undefined);
    }
    setError(null);
    settle(false);
  }, [settle]);

  /** Wait for the desktop app's own browser round trip to finish. */
  const runInMain = useCallback(
    (provider: EngineProvider, run: () => Promise<unknown>): Promise<boolean> => {
      const next: EngineConnectFlow = { kind: "browser", provider };
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
   * Begin adding (or signing in again) an account. Resolves true once it is
   * connected, false when cancelled; throws when the flow could not start
   * or the sign-in failed.
   */
  const start = useCallback(
    async (provider: EngineProvider, options: EngineConnectOptions = {}): Promise<boolean> => {
      if (flowRef.current) cancel();
      setError(null);
      if (provider === "anthropic") {
        const connectClaude = window.electronAPI?.system?.connectClaudeAccount;
        if (!connectClaude) throw new Error("Claude sign-in needs the Stella desktop app.");
        return await runInMain(provider, connectClaude);
      }
      const connectInMain = window.electronAPI?.system?.connectChatGptCloud;
      if (connectInMain) {
        return await runInMain(provider, () => connectInMain(options));
      }
      setBusy(true);
      let next: EngineConnectFlow;
      try {
        const started = await backendClient.call("engines.startConnect", {
          provider: "chatgpt",
          ...(options.accountId ? { accountId: options.accountId } : {}),
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

  /** ChatGPT in a browser: open the authorization page again. */
  const openAuthorizePage = useCallback(() => {
    const current = flowRef.current;
    if (current?.kind === "paste") openExternalUrl(current.authorizeUrl);
  }, []);

  /** ChatGPT in a browser: the address the browser landed on after approval. */
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
      if (current?.kind === "browser" && current.provider === "anthropic") {
        void window.electronAPI?.system?.cancelClaudeAccountConnect?.().catch(() => undefined);
      } else if (current?.kind === "browser") {
        void window.electronAPI?.system?.cancelChatGptCloudConnect?.().catch(() => undefined);
      }
      settleRef.current?.(false);
    },
    [],
  );

  return { flow, busy, error, start, cancel, finish, openAuthorizePage };
}

export type EngineConnect = ReturnType<typeof useEngineConnect>;
