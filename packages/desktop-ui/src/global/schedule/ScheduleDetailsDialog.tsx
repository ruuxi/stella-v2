import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import type {
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
  ScheduleToolAffectedRef,
} from "@stella/contracts/scheduling";
import { formatNextRun, summarizeSchedule } from "./format-schedule";
import { useT, useTPlural } from "@/shared/i18n";
import "./schedule-details-dialog.css";

const NEXT_RUN_TICK_MS = 30_000;

type DialogRow = {
  kind: "cron" | "heartbeat";
  id: string;
  name: string;
  enabled: boolean;
  nextRunAtMs: number;

  recurrence: string;

  conversationId?: string;
};

type Translate = ReturnType<typeof useT>;

const cronToRow = (record: LocalCronJobRecord, t: Translate): DialogRow => ({
  kind: "cron",
  id: record.id,
  name: record.name?.trim() || t("global.schedule.untitledTask"),
  enabled: record.enabled,
  nextRunAtMs: record.nextRunAtMs,
  recurrence: summarizeSchedule(record.schedule),
  conversationId: record.conversationId,
});

const heartbeatToRow = (
  record: LocalHeartbeatConfigRecord,
  t: Translate,
): DialogRow => ({
  kind: "heartbeat",
  id: record.id,
  name: (() => {
    const prompt = record.prompt?.trim();
    if (!prompt) return t("global.schedule.checkIn");
    return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  })(),
  enabled: record.enabled,
  nextRunAtMs: record.nextRunAtMs,
  recurrence: summarizeSchedule(null, record.intervalMs),
  conversationId: record.conversationId,
});

function useResolvedRows(
  affectedRefs: ReadonlyArray<ScheduleToolAffectedRef>,
  open: boolean,
): { rows: DialogRow[]; refreshTick: number; bumpRefresh: () => void } {
  const t = useT();
  const [rows, setRows] = useState<DialogRow[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!open || affectedRefs.length === 0 || !window.electronAPI?.schedule) {
      setRows([]);
      return;
    }
    const api = window.electronAPI.schedule;
    let cancelled = false;
    const run = async () => {
      try {
        const [crons, heartbeats] = await Promise.all([
          api.listCronJobs(),
          api.listHeartbeats(),
        ]);
        if (cancelled) return;
        const cronById = new Map(crons.map((cron) => [cron.id, cron]));
        const heartbeatById = new Map(
          heartbeats.map((heartbeat) => [heartbeat.id, heartbeat]),
        );
        const next: DialogRow[] = [];
        for (const ref of affectedRefs) {
          if (ref.kind === "cron") {
            const found = cronById.get(ref.id);
            if (found) next.push(cronToRow(found, t));
            continue;
          }
          const found = heartbeatById.get(ref.id);
          if (found) next.push(heartbeatToRow(found, t));
        }
        setRows(next);
      } catch {
        if (cancelled) return;
        setRows([]);
      }
    };
    void run();
    const unsubscribe = api.onUpdated(() => {
      void run();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, affectedRefs, refreshTick, t]);

  const bumpRefresh = () => setRefreshTick((tick) => tick + 1);
  return { rows, refreshTick, bumpRefresh };
}

function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), NEXT_RUN_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

type RowActionsState = {
  busy: "none" | "run" | "pause" | "resume" | "delete";
  error?: string;
};

const initialActionState: RowActionsState = { busy: "none" };

function ScheduleDialogRow({
  row,
  nowMs,
  onMutation,
}: {
  row: DialogRow;
  nowMs: number;
  onMutation: () => void;
}) {
  const t = useT();
  const [state, setState] = useState<RowActionsState>(initialActionState);
  const api = window.electronAPI?.schedule;

  const callMutation = async (
    busy: RowActionsState["busy"],
    fn: () => Promise<unknown>,
  ) => {
    if (!api) return;
    setState({ busy });
    try {
      await fn();
      setState(initialActionState);
      onMutation();
    } catch (error) {
      setState({
        busy: "none",
        error:
          error instanceof Error
            ? error.message
            : t("global.schedule.actionFailed"),
      });
    }
  };

  const onRunNow = () => {
    if (!api) return;
    void callMutation("run", () =>
      row.kind === "cron"
        ? api.runCronJob({ jobId: row.id })
        : row.conversationId
          ? api.runHeartbeat({ conversationId: row.conversationId })
          : Promise.resolve(),
    );
  };

  const onTogglePause = () => {
    if (!api) return;
    const next = !row.enabled;
    const busy: RowActionsState["busy"] = next ? "resume" : "pause";
    void callMutation(busy, () =>
      row.kind === "cron"
        ? api.updateCronJob({ jobId: row.id, patch: { enabled: next } })
        : row.conversationId
          ? api.upsertHeartbeat({
              conversationId: row.conversationId,
              enabled: next,
            })
          : Promise.resolve(),
    );
  };

  const onDelete = () => {
    if (!api) return;
    if (row.kind === "cron") {
      void callMutation("delete", () => api.removeCronJob({ jobId: row.id }));
    } else if (row.conversationId) {

      void callMutation("delete", () =>
        api.upsertHeartbeat({
          conversationId: row.conversationId!,
          enabled: false,
        }),
      );
    }
  };

  const badge = row.enabled
    ? formatNextRun(row.nextRunAtMs, nowMs)
    : t("global.schedule.paused");

  return (
    <li className="schedule-details-dialog__row" data-enabled={row.enabled}>
      <div className="schedule-details-dialog__row-main">
        <span className="schedule-details-dialog__row-name">{row.name}</span>
        <span className="schedule-details-dialog__row-meta">
          {row.recurrence ? (
            <>
              <span>{row.recurrence}</span>
              <span className="schedule-details-dialog__row-meta-sep">·</span>
            </>
          ) : null}
          <span>{badge}</span>
        </span>
      </div>
      <div className="schedule-details-dialog__row-actions">
        <Button
          type="button"
          className="pill-btn"
          disabled={state.busy !== "none" || !row.enabled}
          onClick={onRunNow}
        >
          {state.busy === "run"
            ? t("global.schedule.running")
            : t("global.schedule.runNow")}
        </Button>
        <Button
          type="button"
          className="pill-btn"
          disabled={state.busy !== "none"}
          onClick={onTogglePause}
        >
          {state.busy === "pause"
            ? t("global.schedule.pausing")
            : state.busy === "resume"
              ? t("global.schedule.resuming")
              : row.enabled
                ? t("global.schedule.pause")
                : t("global.schedule.resume")}
        </Button>
        <Button
          type="button"
          className="pill-btn pill-btn--danger"
          disabled={state.busy !== "none"}
          onClick={onDelete}
        >
          {state.busy === "delete"
            ? t("global.schedule.removing")
            : t("global.schedule.delete")}
        </Button>
      </div>
      {state.error && (
        <p className="schedule-details-dialog__row-error" role="alert">
          {state.error}
        </p>
      )}
    </li>
  );
}

export type ScheduleDetailsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  affected: ReadonlyArray<ScheduleToolAffectedRef>;

  summary?: string;
};

export function ScheduleDetailsDialog({
  open,
  onOpenChange,
  affected,
  summary,
}: ScheduleDetailsDialogProps) {
  const t = useT();
  const tPlural = useTPlural();
  const { rows, bumpRefresh } = useResolvedRows(affected, open);
  const nowMs = useNowTick(open && rows.length > 0);

  const title = useMemo(() => {
    if (rows.length === 0) return t("global.schedule.dialogTitle");
    if (rows.length === 1) return rows[0].name;
    return tPlural("global.schedule.scheduleCount", rows.length);
  }, [rows, t, tPlural]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="md" fit className="schedule-details-dialog">
        <Dialog.Header>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.CloseButton />
        </Dialog.Header>
        {summary && (
          <Dialog.Description>{summary}</Dialog.Description>
        )}
        <Dialog.Body>
          {rows.length === 0 ? (
            <p className="schedule-details-dialog__empty">
              {t("global.schedule.missing")}
            </p>
          ) : (
            <ul className="schedule-details-dialog__rows">
              {rows.map((row) => (
                <ScheduleDialogRow
                  key={`${row.kind}:${row.id}`}
                  row={row}
                  nowMs={nowMs}
                  onMutation={bumpRefresh}
                />
              ))}
            </ul>
          )}
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
