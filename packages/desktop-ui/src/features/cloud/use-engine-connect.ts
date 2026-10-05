import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineProvider } from "@stella/contracts/backend/engines";
import { backendClient } from "@/platform/backend/backend-client";
import { openExternalUrl } from "@/platform/electron/open-external";

/**
 * Adding a Claude or ChatGPT account to the owner's Stella account, where
 * every computer and the cloud read it. Claude signs in on this computer:
 * Electron main opens the browser, receives the code on its loopback
 * listener, exchanges it with Anthropic and uploads the tokens; this window
 * only waits. ChatGPT uses device authorization through the server and
 * connects by itself once the user approves the code.
 */

export type EngineConnectFlow =
  | { kind: "browser"; provider: "anthropic" }
  | {
      kind: "device";
      provider: EngineProvider;
      connectId: string;
      authorizeUrl: string;
      userCode: string;
      intervalMs: number;
    };

const DEVICE_DEADLINE_MS = 15 * 60_000;

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
    if (current?.kind === "device") {
      void backendClient
        .call("engines.cancelConnect", { connectId: current.connectId })
        .catch(() => undefined);
    } else if (current?.kind === "browser") {
      void window.electronAPI?.system?.cancelClaudeAccountConnect?.().catch(() => undefined);
    }
    settle(false);
  }, [settle]);

  /**
   * Begin adding an account. Resolves true once it is connected, false when
   * the flow was cancelled; throws when the flow could not start, the Claude
   * sign-in failed, or the ChatGPT approval could not be confirmed.
   */
  const start = useCallback(
    async (provider: EngineProvider): Promise<boolean> => {
      if (flowRef.current) cancel();
      setError(null);
      if (provider === "anthropic") {
        const connectClaude = window.electronAPI?.system?.connectClaudeAccount;
        if (!connectClaude) throw new Error("Claude sign-in needs the Stella desktop app.");
        const next: EngineConnectFlow = { kind: "browser", provider };
        flowRef.current = next;
        setFlow(next);
        return await new Promise<boolean>((resolve, reject) => {
          settleRef.current = (outcome) =>
            outcome instanceof Error ? reject(outcome) : resolve(outcome);
          connectClaude().then(
            () => {
              if (flowRef.current === next) settle(true);
            },
            (caught: unknown) => {
              if (flowRef.current !== next) return;
              settle(new Error(messageOf(caught) ?? "That didn't connect. Try again."));
            },
          );
        });
      }
      setBusy(true);
      let next: EngineConnectFlow;
      try {
        next = {
          kind: "device",
          provider,
          ...(await backendClient.call("engines.startDeviceConnect", {})),
        };
      } finally {
        setBusy(false);
      }
      return await new Promise<boolean>((resolve, reject) => {
        settleRef.current = (outcome) =>
          outcome instanceof Error ? reject(outcome) : resolve(outcome);
        flowRef.current = next;
        setFlow(next);
      });
    },
    [cancel, settle],
  );

  /** ChatGPT: copy the one-time code and open the approval page. */
  const openDevicePage = useCallback(() => {
    const current = flowRef.current;
    if (!current || current.kind !== "device") return;
    void navigator.clipboard?.writeText(current.userCode).catch(() => undefined);
    openExternalUrl(current.authorizeUrl);
  }, []);

  useEffect(() => {
    if (!flow || flow.kind !== "device") return;
    let cancelled = false;
    let failures = 0;
    const deadline = Date.now() + DEVICE_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await backendClient.call("engines.pollDeviceConnect", {
          connectId: flow.connectId,
        });
        if (cancelled) return;
        failures = 0;
        if (result.status === "connected") {
          settle(true);
          return;
        }
      } catch (caught) {
        if (cancelled) return;
        // Approval in the browser can outlast a brief connection loss.
        if (++failures >= 4 || Date.now() >= deadline) {
          settle(caught instanceof Error ? caught : new Error("That didn't connect."));
          return;
        }
      }
      timer = setTimeout(() => void poll(), flow.intervalMs);
    };
    timer = setTimeout(() => void poll(), flow.intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, settle]);

  // Leaving the surface abandons the attempt.
  useEffect(
    () => () => {
      if (flowRef.current?.kind === "browser") {
        void window.electronAPI?.system?.cancelClaudeAccountConnect?.().catch(() => undefined);
      }
      settleRef.current?.(false);
    },
    [],
  );

  return { flow, busy, error, start, cancel, openDevicePage };
}

export type EngineConnect = ReturnType<typeof useEngineConnect>;
