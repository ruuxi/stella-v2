import { useCallback, useEffect, useRef, useState } from "react";
import { cloudEnginesApi } from "@/features/cloud/cloud-engines-api";
import { openExternalUrl } from "@/platform/electron/open-external";

/**
 * Signing a Claude account in, on this computer or in the owner's cloud.
 * Both run the real `claude auth login`: on this computer Electron main
 * runs it with the chosen config dir and opens Anthropic's page; in the
 * cloud it runs in the owner's container and this window opens the page.
 * Either way the user pastes the code Anthropic shows back here, and it
 * goes straight to that waiting CLI. A wrong code ends that CLI, so a
 * failed attempt is started again rather than retried.
 */

export type ClaudeLoginTarget =
  | { place: "local"; configId?: string; email?: string }
  | { place: "cloud"; email?: string };

export type ClaudeLoginFlow = {
  target: ClaudeLoginTarget;
  loginId: string;
  authorizeUrl: string;
};

export type ClaudeLoginResult = { email?: string };

/** The error's own message (the CLI's, for a rejected code); null when it has none. */
const messageOf = (error: unknown): string | null =>
  error instanceof Error && error.message ? error.message : null;

const cancelLogin = (flow: ClaudeLoginFlow) => {
  if (flow.target.place === "local") {
    void window.electronAPI?.system?.cancelClaudeLocalLogin?.(flow.loginId).catch(() => undefined);
  } else {
    void cloudEnginesApi.cancelClaudeCloudLogin(flow.loginId).catch(() => undefined);
  }
};

export function useClaudeLogin({
  onSignedIn,
}: {
  onSignedIn?: (result: ClaudeLoginResult, target: ClaudeLoginTarget) => void;
} = {}) {
  const [flow, setFlow] = useState<ClaudeLoginFlow | null>(null);
  /** The target of the attempt being started (before a flow exists). */
  const [starting, setStarting] = useState<ClaudeLoginTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last code was rejected; its CLI has ended. */
  const [failed, setFailed] = useState<ClaudeLoginTarget | null>(null);
  const flowRef = useRef<ClaudeLoginFlow | null>(null);
  flowRef.current = flow;
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const start = useCallback(async (target: ClaudeLoginTarget) => {
    const current = flowRef.current;
    if (current) cancelLogin(current);
    flowRef.current = null;
    setFlow(null);
    setError(null);
    setFailed(null);
    setStarting(target);
    try {
      let next: ClaudeLoginFlow;
      if (target.place === "local") {
        const run = window.electronAPI?.system?.startClaudeLocalLogin;
        if (!run) throw new Error();
        // Main opens Anthropic's page itself.
        const started = await run({
          ...(target.configId ? { configId: target.configId } : {}),
          ...(target.email ? { email: target.email } : {}),
        });
        next = { target, ...started };
      } else {
        const started = await cloudEnginesApi.startClaudeCloudLogin(target.email);
        next = { target, ...started };
        openExternalUrl(started.authorizeUrl);
      }
      flowRef.current = next;
      setFlow(next);
    } catch (caught) {
      setError(messageOf(caught));
      setFailed(target);
    } finally {
      setStarting(null);
    }
  }, []);

  const submit = useCallback(async (code: string) => {
    const current = flowRef.current;
    const trimmed = code.trim();
    if (!current || !trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      let result: ClaudeLoginResult;
      if (current.target.place === "local") {
        const finish = window.electronAPI?.system?.finishClaudeLocalLogin;
        if (!finish) throw new Error();
        const config = await finish(current.loginId, trimmed);
        result = config.email ? { email: config.email } : {};
      } else {
        const done = await cloudEnginesApi.finishClaudeCloudLogin(current.loginId, trimmed);
        result = { email: done.email };
      }
      if (flowRef.current !== current) return;
      flowRef.current = null;
      setFlow(null);
      onSignedInRef.current?.(result, current.target);
    } catch (caught) {
      if (flowRef.current !== current) return;
      // The CLI's own message, verbatim. Its process has ended.
      setError(messageOf(caught));
      flowRef.current = null;
      setFlow(null);
      setFailed(current.target);
    } finally {
      setSubmitting(false);
    }
  }, []);

  const cancel = useCallback(() => {
    const current = flowRef.current;
    if (current) cancelLogin(current);
    flowRef.current = null;
    setFlow(null);
    setError(null);
    setFailed(null);
  }, []);

  const restart = useCallback(() => {
    if (failed) void start(failed);
  }, [failed, start]);

  const reopen = useCallback(() => {
    const current = flowRef.current;
    if (current) openExternalUrl(current.authorizeUrl);
  }, []);

  // Leaving the surface abandons the attempt.
  useEffect(
    () => () => {
      const current = flowRef.current;
      if (current) cancelLogin(current);
    },
    [],
  );

  return {
    flow,
    starting,
    submitting,
    error,
    failed,
    /** A sign-in is in progress or waiting for "Start again". */
    open: flow !== null || starting !== null || failed !== null,
    start,
    submit,
    cancel,
    restart,
    reopen,
  };
}

export type ClaudeLogin = ReturnType<typeof useClaudeLogin>;
