export type DesktopSteerPumpOutcome = "drained" | "blocked" | "stopped";

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
