const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireJobId = (channel: string, payload: Record<string, unknown>) => {
  const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
  if (!jobId) {
    throw new Error(`${channel} requires a jobId string.`);
  }
  return jobId;
};

const requirePackedPayload = (channel: string, args: unknown[]) => {
  const [payload] = args;
  if (args.length !== 1 || !isPlainObject(payload)) {
    throw new Error(`${channel} expects a single payload object.`);
  }
  return payload;
};

type InvokeGuard = (args: unknown[]) => unknown[];

const INVOKE_GUARDS: Record<string, InvokeGuard> = {

  "schedule:updateCronJob": (args) => {
    const payload = requirePackedPayload("schedule:updateCronJob", args);
    const jobId = requireJobId("schedule:updateCronJob", payload);
    if (!isPlainObject(payload.patch)) {
      throw new Error(
        "schedule:updateCronJob requires a patch object.",
      );
    }
    const patch = payload.patch;
    const unexpected = Object.keys(patch).filter((key) => key !== "enabled");
    if (unexpected.length > 0) {
      throw new Error(
        "schedule:updateCronJob over the mobile bridge only accepts an " +
          `{ enabled } patch; rejected field(s): ${unexpected.join(", ")}. ` +
          "Edit the schedule on the computer instead.",
      );
    }
    if (typeof patch.enabled !== "boolean") {
      throw new Error(
        "schedule:updateCronJob requires patch.enabled to be a boolean.",
      );
    }

    return [{ jobId, patch: { enabled: patch.enabled } }];
  },

  "schedule:removeCronJob": (args) => {
    const payload = requirePackedPayload("schedule:removeCronJob", args);
    const jobId = requireJobId("schedule:removeCronJob", payload);
    return [{ jobId }];
  },
};

export const guardMobileBridgeInvokeArgs = (
  channel: string,
  args: unknown[],
): unknown[] => {
  const guard = INVOKE_GUARDS[channel];
  return guard ? guard(args) : args;
};
