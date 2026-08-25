import type { QueuedOrchestratorTurn } from "./types.js";

const normalizeQueueError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export const executeOrQueueUserOrchestratorTurn = async <T>(args: {
  hasActiveRun: boolean;
  queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
  execute: () => Promise<T>;
}): Promise<T> => {
  if (!args.hasActiveRun) {
    return await args.execute();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(normalizeQueueError(error));
    };
    args.queueOrchestratorTurn({
      priority: "user",
      execute: async () => {
        if (settled) return;
        try {
          settleResolve(await args.execute());
        } catch (error) {
          settleReject(error);
        }
      },
      cancel: settleReject,
    });
  });
};

export const executeOrQueueSystemOrchestratorTurn = async (args: {
  hasActiveRun: boolean;
  queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
  execute: () => Promise<void>;
}): Promise<void> => {
  if (!args.hasActiveRun) {
      await args.execute();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(normalizeQueueError(error));
    };
    args.queueOrchestratorTurn({
      priority: "system",
      execute: async () => {
        if (settled) return;
        try {
          await args.execute();
          settleResolve();
        } catch (error) {
          settleReject(error);
        }
      },
      cancel: settleReject,
    });
  });
};
