/**
 * Mobile client for the paired computer's LOCAL schedules.
 *
 * Scheduling in v2 lives in the desktop's local runtime (`LocalSchedulerService`,
 * state on the user's machine) — the backend schema deliberately has no
 * schedule tables. So this reads the user's computer's cron jobs + heartbeats
 * THROUGH the existing encrypted desktop bridge (the same pairing the computer
 * chat uses), not from Convex.
 *
 * Read + cron mutations only: the runtime exposes pause/resume (`enabled`
 * patch) and delete for cron jobs; heartbeats stay read-only here for now.
 * Live updates ride the bridge's `schedule:updated` broadcast.
 */

import {
  formatNextRun,
  parseStoredSchedule,
  summarizeSchedule,
} from "./schedule-format";

export type MobileSchedule = {
  kind: "cron" | "heartbeat";
  id: string;
  /** Cron `name`, or the heartbeat's prompt excerpt / "Check-in". */
  title: string;
  conversationId: string;
  enabled: boolean;
  nextRunAtMs: number;
  /** Serialized LocalCronSchedule for crons; absent for heartbeats. */
  scheduleJson?: string;
  /** Heartbeat cadence (ms); absent for crons. */
  intervalMs?: number;
  lastStatus?: string;
  lastError?: string;
  running: boolean;
};

type RawRecord = Record<string, unknown>;

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const heartbeatTitle = (record: RawRecord): string => {
  const prompt = asTrimmedString(record.prompt);
  if (prompt) {
    // Heartbeat prompts are short instructions; first ~60 chars identifies
    // the schedule without dumping the whole checklist (desktop parity).
    return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  }
  return "Check-in";
};

const readCronRow = (value: unknown): MobileSchedule | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as RawRecord;
  const id = asTrimmedString(record.id);
  const conversationId = asTrimmedString(record.conversationId);
  const nextRunAtMs = asFiniteNumber(record.nextRunAtMs);
  if (!id || !conversationId || nextRunAtMs === undefined) return null;
  return {
    kind: "cron",
    id,
    title: asTrimmedString(record.name) ?? "Scheduled task",
    conversationId,
    enabled: record.enabled === true,
    nextRunAtMs,
    scheduleJson:
      record.schedule && typeof record.schedule === "object"
        ? JSON.stringify(record.schedule)
        : undefined,
    lastStatus: asTrimmedString(record.lastStatus),
    lastError: asTrimmedString(record.lastError),
    running: record.runningAtMs !== undefined,
  };
};

const readHeartbeatRow = (value: unknown): MobileSchedule | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as RawRecord;
  const id = asTrimmedString(record.id);
  const conversationId = asTrimmedString(record.conversationId);
  const nextRunAtMs = asFiniteNumber(record.nextRunAtMs);
  const intervalMs = asFiniteNumber(record.intervalMs);
  if (!id || !conversationId || nextRunAtMs === undefined || !intervalMs) {
    return null;
  }
  return {
    kind: "heartbeat",
    id,
    title: heartbeatTitle(record),
    conversationId,
    enabled: record.enabled === true,
    nextRunAtMs,
    intervalMs,
    lastStatus: asTrimmedString(record.lastStatus),
    lastError: asTrimmedString(record.lastError),
    running: record.runningAtMs !== undefined,
  };
};

/**
 * Defensive parse of the bridge's two lists — a bad row drops itself instead
 * of failing the tab. Sorted next-run first with paused rows sunk to the
 * bottom. This deliberately differs from the desktop's Up-next hook
 * (`use-conversation-schedules.ts`), which DROPS disabled entries outright:
 * on the phone a paused row must stay visible so it can be resumed.
 */
export const parseMobileSchedules = (payload: {
  cronJobs?: unknown;
  heartbeats?: unknown;
}): MobileSchedule[] => {
  const rows: MobileSchedule[] = [];
  if (Array.isArray(payload?.cronJobs)) {
    for (const entry of payload.cronJobs) {
      const parsed = readCronRow(entry);
      if (parsed) rows.push(parsed);
    }
  }
  if (Array.isArray(payload?.heartbeats)) {
    for (const entry of payload.heartbeats) {
      const parsed = readHeartbeatRow(entry);
      if (parsed) rows.push(parsed);
    }
  }
  const seen = new Set<string>();
  const out: MobileSchedule[] = [];
  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.nextRunAtMs - b.nextRunAtMs;
  });
};

/**
 * The two row-rendering decisions the Schedule tab makes per row, extracted
 * so they are testable production code rather than inline JSX ternaries.
 */
export type ScheduleRowBadge =
  | { kind: "paused" }
  | { kind: "next"; label: string };

/** Paused rows show a Paused badge; active rows show the next-run label. */
export const scheduleRowBadge = (
  schedule: Pick<MobileSchedule, "enabled" | "nextRunAtMs">,
  nowMs: number,
): ScheduleRowBadge =>
  schedule.enabled
    ? { kind: "next", label: formatNextRun(schedule.nextRunAtMs, nowMs) }
    : { kind: "paused" };

/**
 * Natural-language cadence line for a row — stored cron/at/every JSON for
 * crons, the interval for heartbeats. Empty string when the shape is too
 * custom to summarize (the UI falls back to its localized "custom" copy).
 */
export const scheduleCadence = (
  schedule: Pick<MobileSchedule, "scheduleJson" | "intervalMs">,
): string =>
  summarizeSchedule(
    schedule.scheduleJson ? parseStoredSchedule(schedule.scheduleJson) : null,
    schedule.intervalMs,
  );

/** Load every schedule on the paired computer through the desktop bridge. */
export async function fetchMobileSchedules(): Promise<MobileSchedule[]> {
  const { resolveDesktopBridge, invokeDesktopBridge } = await import(
    "./desktop-bridge-chat"
  );
  const { listStoredPairedPhoneAccess } = await import("./phone-access");
  const paired = await listStoredPairedPhoneAccess();
  const access = paired[0];
  if (!access) return [];
  const bridge = await resolveDesktopBridge(access);
  const [cronJobs, heartbeats] = (await Promise.all([
    invokeDesktopBridge<unknown[]>(bridge, "schedule:listCronJobs"),
    invokeDesktopBridge<unknown[]>(bridge, "schedule:listHeartbeats"),
  ])) as [unknown[], unknown[]];
  return parseMobileSchedules({ cronJobs, heartbeats });
}

/**
 * Pause / resume / delete one cron schedule by id. Heartbeats have no mobile
 * mutation surface yet — the runtime's heartbeat upsert is per-conversation
 * config, not a pause toggle.
 */
export type MobileScheduleAction = "pause" | "resume" | "remove";

export async function mutateMobileSchedule(
  action: MobileScheduleAction,
  schedule: MobileSchedule,
): Promise<void> {
  if (schedule.kind !== "cron") {
    throw new Error("Only cron schedules can be changed from your phone.");
  }
  const { resolveDesktopBridge, invokeDesktopBridge } = await import(
    "./desktop-bridge-chat"
  );
  const { listStoredPairedPhoneAccess } = await import("./phone-access");
  const paired = await listStoredPairedPhoneAccess();
  const access = paired[0];
  if (!access) throw new Error("No paired computer.");
  const bridge = await resolveDesktopBridge(access);
  if (action === "remove") {
    await invokeDesktopBridge<boolean>(bridge, "schedule:removeCronJob", [
      { jobId: schedule.id },
    ]);
    return;
  }
  await invokeDesktopBridge<unknown>(
    bridge,
    "schedule:updateCronJob",
    [{ jobId: schedule.id, patch: { enabled: action === "resume" } }],
  );
}

/**
 * Subscribe to the desktop's `schedule:updated` push while the Schedule tab
 * is on screen. Fires `onUpdate` on every broadcast (the payload carries no
 * data — callers refetch the authoritative lists). Deliberately simpler than
 * `desktop-bridge-live`: no reconnect loop — the tab refetches on every
 * open/switch anyway, so a dropped socket only costs liveness until then.
 * The returned close() is idempotent and also cancels an in-flight connect.
 */
export function subscribeMobileScheduleUpdates(
  onUpdate: () => void,
): { close: () => void } {
  let closed = false;
  let socket: { close: () => void } | null = null;
  void (async () => {
    try {
      const { resolveDesktopBridge, openDesktopBridgeEventSocket } =
        await import("./desktop-bridge-chat");
      const { listStoredPairedPhoneAccess } = await import("./phone-access");
      const paired = await listStoredPairedPhoneAccess();
      const access = paired[0];
      if (!access || closed) return;
      const bridge = await resolveDesktopBridge(access);
      if (closed) return;
      const opened = await openDesktopBridgeEventSocket(bridge, {
        channels: ["schedule:updated"],
        onEvent: (channel) => {
          if (channel === "schedule:updated" && !closed) onUpdate();
        },
        onClose: () => {
          socket = null;
        },
      });
      if (closed) {
        opened.close();
        return;
      }
      socket = opened;
    } catch {
      // No pairing / unreachable desktop — the tab still works via refetch.
    }
  })();
  return {
    close: () => {
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}
