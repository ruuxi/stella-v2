import {
  CLOUD_MODEL_DIAGNOSTIC_SENTINELS,
  type CloudModelDiagnosticCode,
} from "@stella/contracts/cloud-model-diagnostic";

export type AgentFailureDiagnosticCode =
  | "execution_missing"
  | "tool_state_boundary"
  | "broker_handoff"
  | "turn_input"
  | "workspace_boundary"
  | "privilege_probe"
  | "conversation_history"
  | "model_resolution"
  | CloudModelDiagnosticCode
  | "broker_response"
  | "capture_wrapper"
  | "capture_exit"
  | "unknown";

/**
 * Collapse executor/turn failures to an allowlisted status code. The source
 * text can contain provider or user-controlled details, so callers must never
 * surface it directly in acceptance receipts or client-visible errors.
 */
export const classifyAgentFailureDiagnostic = (
  detail: string,
): AgentFailureDiagnosticCode => {
  const lines = new Set(detail.split(/\r?\n/u).map((line) => line.trim()));
  for (const [code, sentinel] of Object.entries(
    CLOUD_MODEL_DIAGNOSTIC_SENTINELS,
  ) as Array<[CloudModelDiagnosticCode, string]>) {
    if (
      lines.has(sentinel) ||
      lines.has(`error: ${sentinel}`) ||
      lines.has(`Error: ${sentinel}`) ||
      lines.has(`error: (FiberFailure) Error: ${sentinel}`)
    ) {
      return code;
    }
  }
  const value = detail.toLowerCase();
  if (
    /cannot read (?:properties|property) of undefined.*(?:engine|execution)/u.test(
      value,
    ) ||
    /execution.*(?:missing|undefined|invalid)/u.test(value)
  ) {
    return "execution_missing";
  }
  if (
    value.includes("cloud tool directory") ||
    value.includes("drive hydration state")
  ) {
    return "tool_state_boundary";
  }
  if (
    value.includes("turn broker handoff") ||
    value.includes("turn broker credentials")
  ) {
    return "broker_handoff";
  }
  if (
    value.includes("turn-input.json") ||
    value.includes("turn input")
  ) {
    return "turn_input";
  }
  if (
    value.includes("cloud workspace") ||
    value.includes("workspace root")
  ) {
    return "workspace_boundary";
  }
  if (
    value.includes("cloud privilege") ||
    value.includes("setpriv") ||
    value.includes("no_new_privs")
  ) {
    return "privilege_probe";
  }
  if (value.includes("conversation history")) {
    return "conversation_history";
  }
  if (
    value.includes("cloud model") ||
    value.includes("managed model") ||
    value.includes("model resolver") ||
    value.includes("execution route")
  ) {
    return "model_resolution";
  }
  if (
    value.includes("turn credential broker response") ||
    value.includes("turn credential broker denied")
  ) {
    return "broker_response";
  }
  if (
    value.includes("captured session wrapper") ||
    value.includes("capture wrapper")
  ) {
    return "capture_wrapper";
  }
  if (
    value.includes("captured session exit code") ||
    value.includes("capture exit")
  ) {
    return "capture_exit";
  }
  return "unknown";
};
