export type DesktopSteerPumpOutcome = "drained" | "blocked" | "stopped";

/**
 * Drain one durable mobile steer FIFO. The caller removes an item only from
 * `onAccepted`, so a failed head blocks overtaking and can fall back to a fresh
 * turn after the active root settles.
 */
export const drainDesktopSteerAcceptanceQueue = async <TItem, TReceipt>(args: {
  peek: () => TItem | null;
  accept: (item: TItem) => Promise<TReceipt>;
  onAccepted: (item: TItem, receipt: TReceipt) => void;
  canContinue: () => boolean;
}): Promise<DesktopSteerPumpOutcome> => {
  while (args.canContinue()) {
    const item = args.peek();
    if (!item) return "drained";
    let receipt: TReceipt;
    try {
      receipt = await args.accept(item);
    } catch {
      return "blocked";
    }
    if (!args.canContinue()) return "stopped";
    args.onAccepted(item, receipt);
  }
  return "stopped";
};
