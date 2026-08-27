import { useEffect, useMemo, useState } from "react";
import type {
  LocalCronJobRecord,
  LocalCronSchedule,
  LocalHeartbeatConfigRecord,
} from "@stella/contracts/scheduling";
import { useT } from "@/shared/i18n";

export type ScheduleEntry =
  | {
      kind: "cron";
      id: string;
      name: string;
      enabled: boolean;
      nextRunAtMs: number;
      schedule: LocalCronSchedule;
    }
  | {
      kind: "heartbeat";
      id: string;
      name: string;
      enabled: boolean;
      nextRunAtMs: number;
      intervalMs: number;
    };

const heartbeatDisplayName = (
  record: LocalHeartbeatConfigRecord,
  t: ReturnType<typeof useT>,
): string => {
  const prompt = record.prompt?.trim();
  if (prompt) {

    return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  }
  return t("global.schedule.checkIn");
};

const sortByNextRun = (entries: ScheduleEntry[]): ScheduleEntry[] =>
  [...entries].sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);

const EMPTY: ScheduleEntry[] = [];

export function useConversationSchedules(
  conversationId: string | null,
): ScheduleEntry[] {
  const t = useT();
  const [crons, setCrons] = useState<LocalCronJobRecord[]>([]);
  const [heartbeats, setHeartbeats] = useState<LocalHeartbeatConfigRecord[]>(
    [],
  );

  useEffect(() => {
    if (!conversationId || !window.electronAPI?.schedule) {
      setCrons([]);
      setHeartbeats([]);
      return;
    }
    const api = window.electronAPI.schedule;
    let cancelled = false;

    const load = async () => {
      try {
        const [cronList, heartbeatList] = await Promise.all([
          api.listCronJobs(),
          api.listHeartbeats(),
        ]);
        if (cancelled) return;
        setCrons(cronList);
        setHeartbeats(heartbeatList);
      } catch {
        if (cancelled) return;
        setCrons([]);
        setHeartbeats([]);
      }
    };

    void load();
    const unsubscribe = api.onUpdated(() => {
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId]);

  return useMemo(() => {
    if (!conversationId) return EMPTY;
    const entries: ScheduleEntry[] = [];
    for (const cron of crons) {
      if (cron.conversationId !== conversationId) continue;
      if (!cron.enabled) continue;
      entries.push({
        kind: "cron",
        id: cron.id,
        name: cron.name?.trim() || t("global.schedule.untitledTask"),
        enabled: cron.enabled,
        nextRunAtMs: cron.nextRunAtMs,
        schedule: cron.schedule,
      });
    }
    for (const heartbeat of heartbeats) {
      if (heartbeat.conversationId !== conversationId) continue;
      if (!heartbeat.enabled) continue;
      entries.push({
        kind: "heartbeat",
        id: heartbeat.id,
        name: heartbeatDisplayName(heartbeat, t),
        enabled: heartbeat.enabled,
        nextRunAtMs: heartbeat.nextRunAtMs,
        intervalMs: heartbeat.intervalMs,
      });
    }
    return sortByNextRun(entries);
  }, [conversationId, crons, heartbeats, t]);
}
