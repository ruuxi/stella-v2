import type {
  DurableTurnStateWorkspaceTransfer,
  DurableWorkspaceTransferPlan,
} from "./owner-transfer-coordinator.js";
import type {
  TurnStateTransferActivationResponse,
  TurnStateTransferEntry,
  TurnStateTransferExportResponse,
  TurnStateTransferManifest,
} from "./turn-state-owner-routes.js";

export class TurnStateProductTransferConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnStateProductTransferConflictError";
  }
}

export type TurnStateProductTransferOperations = {
  exportPage: (
    cursor: number,
    limit: number,
  ) => Promise<TurnStateTransferExportResponse>;
  stageEntry: (
    manifest: TurnStateTransferManifest,
    entry: TurnStateTransferEntry,
  ) => Promise<void>;
  activate: (
    manifest: TurnStateTransferManifest,
  ) => Promise<TurnStateTransferActivationResponse>;
  persistExported: (
    manifest: TurnStateTransferManifest,
  ) => Promise<DurableTurnStateWorkspaceTransfer>;
  persistStaged: (args: {
    manifestFingerprint: string;
    previousCursor: number;
    nextCursor: number;
  }) => Promise<DurableTurnStateWorkspaceTransfer>;
  persistActivated: (args: {
    manifestFingerprint: string;
    activationReceipt: string;
  }) => Promise<DurableTurnStateWorkspaceTransfer>;
};

/**
 * Advances at most one bounded strong-state page, then atomically activates
 * the destination. The durable coordinator cursor is the recovery boundary:
 * when the final page was committed but activation or its response was lost,
 * a retry skips export/staging and replays activation from the saved manifest.
 */
export const advanceDurableTurnStateWorkspaceTransfer = async (args: {
  plan: DurableWorkspaceTransferPlan;
  sourcePresent: boolean;
  operations: TurnStateProductTransferOperations;
}): Promise<{ complete: boolean; plan: DurableWorkspaceTransferPlan }> => {
  let turnState = args.plan.turnState;
  if (!args.sourcePresent && !turnState) {
    return { complete: true, plan: args.plan };
  }

  let exportedPage: TurnStateTransferExportResponse | undefined;
  if (!turnState) {
    exportedPage = await args.operations.exportPage(0, 16);
    if (exportedPage.manifest.count < 1) {
      throw new TurnStateProductTransferConflictError(
        "Atomic workspace state disappeared during ownership transfer.",
      );
    }
    turnState = await args.operations.persistExported(exportedPage.manifest);
    args.plan.turnState = turnState;
  }

  if (turnState.phase === "staging") {
    if (turnState.cursor < turnState.manifest.count) {
      const cursor = turnState.cursor;
      const page =
        exportedPage && cursor === 0
          ? exportedPage
          : await args.operations.exportPage(cursor, 16);
      if (
        JSON.stringify(page.manifest) !== JSON.stringify(turnState.manifest) ||
        page.entries.length < 1
      ) {
        throw new TurnStateProductTransferConflictError(
          "Atomic workspace state changed during ownership transfer.",
        );
      }
      for (const entry of page.entries) {
        await args.operations.stageEntry(page.manifest, entry);
      }
      const nextCursor = page.nextCursor ?? page.manifest.count;
      if (
        nextCursor <= cursor ||
        nextCursor > page.manifest.count ||
        nextCursor - cursor !== page.entries.length
      ) {
        throw new Error("Atomic workspace transfer page did not advance.");
      }
      turnState = await args.operations.persistStaged({
        manifestFingerprint: page.manifest.fingerprint,
        previousCursor: cursor,
        nextCursor,
      });
      args.plan.turnState = turnState;
      if (turnState.cursor < turnState.manifest.count) {
        return { complete: false, plan: args.plan };
      }
    }

    const activation = await args.operations.activate(turnState.manifest);
    if (
      activation.manifestFingerprint !== turnState.manifest.fingerprint ||
      activation.count !== turnState.manifest.count ||
      !/^[0-9a-f]{64}$/u.test(activation.activationReceipt)
    ) {
      throw new Error("Atomic workspace activation receipt was invalid.");
    }
    turnState = await args.operations.persistActivated({
      manifestFingerprint: activation.manifestFingerprint,
      activationReceipt: activation.activationReceipt,
    });
    args.plan.turnState = turnState;
  }
  return { complete: true, plan: args.plan };
};
