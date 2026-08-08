export type BridgeRecoveryReason = "route" | "session" | "availability";

export class BridgeRecoveryError extends Error {
  readonly reason: BridgeRecoveryReason;

  constructor(
    reason: BridgeRecoveryReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BridgeRecoveryError";
    this.reason = reason;
  }
}

export const isBridgeRecoveryError = (
  error: unknown,
): error is BridgeRecoveryError =>
  error instanceof BridgeRecoveryError ||
  (error instanceof Error && error.name === "BridgeRecoveryError");

export const bridgeRecoveryReasonForResponse = (
  status: number,
  message: string,
): BridgeRecoveryReason | null => {
  if (status === 401) return "session";
  if (
    status === 403 &&
    /unauthorized|bridge unavailable|session|authorization/i.test(message)
  ) {
    return "availability";
  }
  // Cloudflare route failures use 52x/53x statuses. Handler-originated 500s
  // are deterministic application errors and must never be replayed.
  if (status >= 520 && status < 540) return "route";
  if (status === 502 || status === 503 || status === 504) return "route";
  return null;
};

export const runWithSingleBridgeRecovery = async <TBridge, TResult>(args: {
  initial: TBridge;
  operation: (bridge: TBridge) => Promise<TResult>;
  recover: (error: BridgeRecoveryError) => Promise<TBridge>;
}): Promise<TResult> => {
  try {
    return await args.operation(args.initial);
  } catch (error) {
    if (!isBridgeRecoveryError(error)) throw error;
    const recovered = await args.recover(error);
    return args.operation(recovered);
  }
};
