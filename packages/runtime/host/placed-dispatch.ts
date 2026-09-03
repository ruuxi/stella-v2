import type { DispatchSummary } from "@stella/contracts/turn-plane/placement";

/**
 * Whether a dispatch this desktop submitted has been handed to Stella's cloud.
 *
 * The owner gate starts the conversation's own Durable Object turn, records
 * its id on the row, and never settles the dispatch afterwards: from there the
 * turn is tracked over the conversation socket, exactly as the web shell does
 * once `cloudTurnId` appears. A desktop that kept waiting for a terminal
 * dispatch state would poll the gate forever and never finish its placed run.
 */
export const isCloudHandedOff = (
  status: Pick<DispatchSummary, "placement" | "cloudTurnId"> | null | undefined,
): boolean =>
  Boolean(
    status &&
      status.placement === "cloud" &&
      typeof status.cloudTurnId === "string" &&
      status.cloudTurnId.trim(),
  );
