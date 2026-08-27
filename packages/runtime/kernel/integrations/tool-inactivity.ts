import type { ToolResult } from "../tools/types.js";

export const DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

const configuredInactivityTimeoutMs = (): number => {
  const raw = process.env.STELLA_TOOL_INACTIVITY_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed)
    ? parsed
    : DEFAULT_TOOL_INACTIVITY_TIMEOUT_MS;
};

export const executeToolWithInactivityBound = async (args: {
  toolName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  run: (
    signal: AbortSignal | undefined,
    onActivity: () => void,
  ) => Promise<ToolResult>;
}): Promise<ToolResult> => {
  const timeoutMs = args.timeoutMs ?? configuredInactivityTimeoutMs();
  const toolAbort = new AbortController();
  const onOuterAbort = () => toolAbort.abort(args.signal?.reason);
  if (args.signal?.aborted) onOuterAbort();
  args.signal?.addEventListener("abort", onOuterAbort);
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let rejectOnInactivity: (error: Error) => void = () => {};
  const inactivityFailure = new Promise<never>((_, reject) => {
    rejectOnInactivity = reject;
  });
  inactivityFailure.catch(() => undefined);
  const armInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      const error = new Error(
        `Tool ${args.toolName} produced no output for ${Math.round(timeoutMs / 1000)}s and was cancelled. The agent may retry or continue without it.`,
      );
      toolAbort.abort(error);
      rejectOnInactivity(error);
    }, timeoutMs);
    inactivityTimer.unref?.();
  };
  armInactivityTimer();

  try {
    return await Promise.race([
      args.run(toolAbort.signal, () => {
        if (!timedOut) armInactivityTimer();
      }),
      inactivityFailure,
    ]);
  } catch (error) {
    if (timedOut) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    args.signal?.removeEventListener("abort", onOuterAbort);
  }
};
