/**
 * Field-level narrowing for client-supplied invoke payloads.
 *
 * The capability allowlist (`bridge-policy.ts`) is channel-granular: an
 * exposed channel dispatches into the same privileged `ipcMain.handle`
 * handler the desktop renderer uses, with the client's arguments passed
 * through verbatim. That is the right surface when phone and desktop intend
 * the same operation — but `schedule:updateCronJob` is broader on desktop
 * (the Schedules dialog patches name / schedule / payload / conversationId)
 * than the phone's pause/resume toggle. Without narrowing, any paired client
 * could rewrite an existing cron job into an arbitrary persistent agent
 * prompt — quieter than a chat turn and surviving unpairing.
 *
 * Guards run at the single bridge dispatch choke point
 * (`dispatchCapturedIpc` in `service.js`), covering both the HTTP and
 * WebSocket invoke lanes. They never run for the desktop renderer's own IPC,
 * so the dialog keeps its full patch surface. A guard either returns the
 * rebuilt, validated argument array or throws — the thrown message travels
 * back to the phone as the invoke error.
 */

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
  // Mobile pause/resume lane: the ONLY cron patch a paired client may apply
  // is `{ enabled: boolean }`. Everything else (name, schedule, payload,
  // conversationId, deliver, deleteAfterRun, …) is rejected, not stripped —
  // a client sending those is either broken or hostile, and silently
  // "succeeding" with a narrower write would be worse than failing loudly.
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
    // Rebuild rather than forward: drops prototype baggage and any
    // non-enumerable surprises along with unknown fields.
    return [{ jobId, patch: { enabled: patch.enabled } }];
  },
  // Deletion takes nothing but the id; rebuild to shed extra fields.
  "schedule:removeCronJob": (args) => {
    const payload = requirePackedPayload("schedule:removeCronJob", args);
    const jobId = requireJobId("schedule:removeCronJob", payload);
    return [{ jobId }];
  },
};

/**
 * Returns the validated (possibly rebuilt) argument array for guarded
 * channels, the input untouched for everything else. Throws when a guarded
 * channel's arguments fall outside the narrowed shape.
 */
export const guardMobileBridgeInvokeArgs = (
  channel: string,
  args: unknown[],
): unknown[] => {
  const guard = INVOKE_GUARDS[channel];
  return guard ? guard(args) : args;
};
