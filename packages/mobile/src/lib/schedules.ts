/**
 * The owner's schedules, read live from Convex. Every schedule lives there,
 * whichever computer or the cloud runs it, so the tab works with the
 * computer asleep and opens without a round-trip through it.
 */

import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useCallback } from "react";
import {
  formatNextRun,
  parseStoredSchedule,
  summarizeSchedule,
} from "./schedule-format";

export type MobileSchedule = {
  kind: "cron" | "heartbeat";
  id: string;
  title: string;
  conversationId: string;
  enabled: boolean;
  nextRunAtMs: number;
  /** Serialized LocalCronSchedule for crons; absent for heartbeats. */
  scheduleJson?: string;
  /** Heartbeat cadence (ms); absent for crons. */
  intervalMs?: number;
  /** The computer a fire is offered to first; absent means the cloud. */
  targetDeviceId?: string;
  lastStatus?: string;
  lastError?: string;
  running: boolean;
};

export type CloudScheduleRow = {
  scheduleId: string;
  conversationId?: string;
  targetDeviceId?: string;
  prompt: string;
  schedule: string;
  nextRunAt: number;
  status: string;
  description: string;
  lastError?: string;
};

export type MobileScheduleAction = "pause" | "resume" | "remove";

const listRef = makeFunctionReference<"query", Record<string, never>, CloudScheduleRow[]>(
  "cloud_schedule:listMySchedules",
);
const updateRef = makeFunctionReference<
  "mutation",
  { requestId: string; scheduleId: string; status: "active" | "paused" },
  unknown
>("cloud_schedule:updateMySchedule");
const removeRef = makeFunctionReference<
  "mutation",
  { requestId: string; scheduleId: string },
  null
>("cloud_schedule:removeMySchedule");

export const toMobileSchedule = (row: CloudScheduleRow): MobileSchedule => ({
  kind: "cron",
  id: row.scheduleId,
  title: row.description || row.prompt,
  conversationId: row.conversationId ?? "",
  enabled: row.status === "active",
  nextRunAtMs: row.nextRunAt,
  scheduleJson: row.schedule,
  ...(row.targetDeviceId ? { targetDeviceId: row.targetDeviceId } : {}),
  ...(row.lastError ? { lastError: row.lastError } : {}),
  running: false,
});

/** `undefined` while the first read is in flight. */
export function useMobileSchedules(
  enabled: boolean,
): MobileSchedule[] | undefined {
  const rows = useQuery(listRef, enabled ? {} : "skip");
  return rows?.map(toMobileSchedule);
}

const requestId = (action: string, id: string) =>
  `phone-${action}-${id}-${Date.now().toString(36)}`.slice(0, 128);

export function useScheduleAction() {
  const update = useMutation(updateRef);
  const remove = useMutation(removeRef);
  return useCallback(
    async (action: MobileScheduleAction, schedule: MobileSchedule) => {
      if (action === "remove") {
        await remove({
          requestId: requestId("remove", schedule.id),
          scheduleId: schedule.id,
        });
        return;
      }
      await update({
        requestId: requestId(action, schedule.id),
        scheduleId: schedule.id,
        status: action === "resume" ? "active" : "paused",
      });
    },
    [remove, update],
  );
}

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
 * Natural-language cadence line for a row. Empty string when the shape is
 * too custom to summarize (the UI falls back to its localized "custom" copy).
 */
export const scheduleCadence = (
  schedule: Pick<MobileSchedule, "scheduleJson" | "intervalMs">,
): string =>
  summarizeSchedule(
    schedule.scheduleJson ? parseStoredSchedule(schedule.scheduleJson) : null,
    schedule.intervalMs,
  );
