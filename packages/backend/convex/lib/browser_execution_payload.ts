export type BrowserExecutionPayloadAdmission =
  | { kind: "invalid_json" }
  | { kind: "generation_mismatch" }
  | { kind: "routing_mismatch" }
  | { kind: "ok" };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const payloadDeviceId = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

export function admitBrowserExecutionPayload(args: {
  payloadJson: string;
  expectedOwnerGeneration: string;
  requestedTargetMode: string;
  requestedExecutorDeviceId: string | undefined;
}): BrowserExecutionPayloadAdmission {
  let payload: unknown;
  try {
    payload = JSON.parse(args.payloadJson);
  } catch {
    return { kind: "invalid_json" };
  }
  if (!isPlainObject(payload)) {
    return { kind: "generation_mismatch" };
  }
  if (payload.expectedOwnerGeneration !== args.expectedOwnerGeneration) {
    return { kind: "generation_mismatch" };
  }
  if (
    (payload.requestedTargetMode ?? "automatic") !== args.requestedTargetMode ||
    payloadDeviceId(payload.requestedExecutorDeviceId) !==
      args.requestedExecutorDeviceId
  ) {
    return { kind: "routing_mismatch" };
  }
  return { kind: "ok" };
}
