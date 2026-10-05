import type { AgentThreadLookup } from "./agent-threads.js";

export type AgentThreadViewer =
  | { host: "cloud" }
  | { host: "desktop"; deviceId: string };

const REPORT_MAX_CHARS = 8_000;

export const isAgentThreadLookupActive = (thread: AgentThreadLookup): boolean =>
  thread.status === "running" || thread.status === "resuming";

const deviceName = (label: string | undefined, deviceId: string | undefined): string =>
  label?.trim() || deviceId || "another computer";

export const agentThreadLookupLocation = (thread: AgentThreadLookup): string =>
  thread.executorDeviceId
    ? `on ${deviceName(thread.executorDeviceLabel, thread.executorDeviceId)}`
    : thread.placement === "computer"
      ? `locally on ${deviceName(thread.originDeviceLabel, thread.originDeviceId)}`
      : "in Stella's cloud";

export const agentThreadLookupStartedByViewer = (
  thread: AgentThreadLookup,
  viewer: AgentThreadViewer,
): boolean =>
  viewer.host === "desktop"
    ? thread.originDeviceId === viewer.deviceId
    : !thread.originDeviceId && !thread.parentThreadId;

export const agentThreadLookupController = (
  thread: AgentThreadLookup,
  viewer: AgentThreadViewer,
): string => {
  if (thread.originDeviceId) {
    const origin = deviceName(thread.originDeviceLabel, thread.originDeviceId);
    if (viewer.host === "desktop" && viewer.deviceId === thread.originDeviceId) {
      return "This computer started it.";
    }
    return `It was started from ${origin} while this conversation ran there, so only ${origin} can send it input or pause it, and its report returns there.`;
  }
  if (thread.parentThreadId) {
    return `It was started by another agent of this conversation (thread ${thread.parentThreadId}), which is the one that can send it input or pause it.`;
  }
  return viewer.host === "desktop"
    ? "It was started by this conversation's orchestrator in Stella's cloud, so only the cloud can send it input or pause it. Its report still returns to this conversation."
    : "It was started by this conversation.";
};

const MINUTE_MS = 60_000;

const sinceLabel = (ms: number): string => {
  if (ms < MINUTE_MS) return "just now";
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
};

/**
 * What the running attempt is doing, for a reader who can only see the ledger.
 * Without this an active thread looks the same whether it is working or wedged,
 * which is the one question a status check is usually asked to answer. There is
 * deliberately no verdict here: the gap between "last did something" and now,
 * next to whether a tool is still outstanding, is what a human or an
 * orchestrator needs, and no threshold could tell a long build from a hang.
 */
export const agentThreadLookupProgress = (
  thread: AgentThreadLookup,
  now = Date.now(),
): string | undefined => {
  const activity = thread.activity;
  if (!activity || !isAgentThreadLookupActive(thread)) return undefined;
  const since = sinceLabel(Math.max(0, now - activity.lastActivityAt));
  const tools = activity.activeToolCount;
  const outstanding =
    tools === undefined
      ? ""
      : tools > 0
        ? ` ${tools} tool call${tools === 1 ? "" : "s"} still outstanding.`
        : " No tool call outstanding.";
  return `Last activity ${since}${activity.label ? ` (${activity.label})` : ""}.${outstanding}`;
};

export const agentThreadLookupReport = (thread: AgentThreadLookup): string | undefined => {
  if (!thread.resultJson) return undefined;
  let text = thread.resultJson;
  try {
    const parsed = JSON.parse(thread.resultJson) as unknown;
    if (typeof parsed === "string") {
      text = parsed;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { finalText?: unknown }).finalText === "string"
    ) {
      text = (parsed as { finalText: string }).finalText;
    }
  } catch {
    text = thread.resultJson;
  }
  return text.length > REPORT_MAX_CHARS
    ? `${text.slice(0, REPORT_MAX_CHARS)}\n[Report truncated]`
    : text;
};

export const describeAgentThreadLookup = (
  thread: AgentThreadLookup,
  viewer: AgentThreadViewer,
): string => {
  const active = isAgentThreadLookupActive(thread);
  const report = active ? undefined : agentThreadLookupReport(thread);
  return [
    `Thread ${thread.threadId} (${thread.description}) runs ${agentThreadLookupLocation(thread)} and is ${thread.status} (attempt ${thread.attemptGeneration}, last change ${new Date(thread.updatedAt).toISOString()}).`,
    agentThreadLookupProgress(thread) ?? "",
    agentThreadLookupController(thread, viewer),
    report !== undefined
      ? `Report for this attempt:\n${report}`
      : !active && thread.errorMessage
        ? `Error: ${thread.errorMessage}`
        : "",
  ]
    .filter(Boolean)
    .join(" ");
};
