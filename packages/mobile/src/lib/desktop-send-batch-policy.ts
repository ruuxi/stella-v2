export const canReuseDesktopSendBatch = (
  batch: { desktopDeviceId: string; closed: boolean } | null | undefined,
  desktopDeviceId: string,
): boolean =>
  Boolean(batch && !batch.closed && batch.desktopDeviceId === desktopDeviceId);

export const shouldReuseQueuedReplayBatch = (args: {
  queueSequence: number | undefined;
  batchReady: boolean;
}): boolean => args.queueSequence !== undefined && args.batchReady;
