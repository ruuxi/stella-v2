import { useEffect, useState } from "react";
import type {
  AppSourceActionResult,
  AppSourceState,
} from "@stella/contracts/desktop/app-source";
import { History, RefreshCw } from "@/ui/icons";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { showToast } from "@/ui/toast";
import { dispatchStellaSendMessage } from "@/shared/lib/stella-send-message";
import { useLocale, useT } from "@/shared/i18n";
import "./shell-topbar-update-pill.css";
import "./shell-topbar-app-source.css";

const useAppSourceState = () => {
  const [state, setState] = useState<AppSourceState | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.appSource;
    if (!api) return;
    let disposed = false;
    const unsubscribe = api.onState((next) => {
      if (!disposed) setState(next);
    });
    void api
      .getState()
      .then((next) => {
        if (!disposed && next) setState(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return state;
};

const formatAgo = (locale: string, date: number) => {
  const minutes = Math.round((date - Date.now()) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
};

/**
 * Changes to Stella itself when it runs from source: drafts an agent finished,
 * changes made on the user's other computers, updates to the published app,
 * and recent changes to undo.
 * Release updates stay with `ShellTopBarUpdatePill`.
 */
export const ShellTopBarAppSource = () => {
  const t = useT();
  const locale = useLocale();
  const state = useAppSourceState();
  const [open, setOpen] = useState(false);
  const [conflictingUndo, setConflictingUndo] = useState<string | null>(null);
  if (!state) return null;

  const remoteAhead = state.remote.status === "ahead";
  const diverged = state.remote.status === "diverged";
  const upstreamAhead = state.upstream.status === "ahead";
  const upstreamDiverged = state.upstream.status === "diverged";
  const hasReady = state.ready.length > 0 || remoteAhead || upstreamAhead;
  const conflict = state.recent.find(
    (commit) => commit.sha === conflictingUndo,
  );
  const hasAttention =
    state.stale.length > 0 ||
    diverged ||
    upstreamDiverged ||
    Boolean(conflict);
  if (!hasReady && !hasAttention && state.recent.length === 0) return null;

  const run = async (
    action: () => Promise<AppSourceActionResult>,
    onConflict?: () => void,
  ) => {
    const result = await action().catch(
      (error: unknown): AppSourceActionResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    if (result.ok) return;
    if (result.conflict && onConflict) {
      onConflict();
      return;
    }
    showToast({
      title: t("shell.appSource.failed"),
      description: result.error,
      variant: "error",
    });
  };
  const api = window.electronAPI!.appSource;
  const ask = (text: string) => {
    setOpen(false);
    setConflictingUndo(null);
    dispatchStellaSendMessage({ text }, { openPanel: false });
  };

  const label = t("shell.appSource.title");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {hasReady ? (
        <div className="shell-topbar-update-pill" data-state="downloaded">
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shell-topbar-update-pill__main"
              aria-label={label}
              title={label}
            >
              <RefreshCw
                className="shell-topbar-update-pill__icon"
                size={12}
                strokeWidth={2}
                aria-hidden
              />
              <span className="shell-topbar-update-pill__label">
                {t("shell.appSource.update")}
              </span>
            </button>
          </PopoverTrigger>
        </div>
      ) : (
        <PopoverTrigger asChild>
          <button
            type="button"
            className="shell-topbar-icon-btn shell-topbar-app-source__icon"
            data-attention={hasAttention || undefined}
            aria-label={label}
            title={label}
          >
            <History size={16} strokeWidth={1.75} />
          </button>
        </PopoverTrigger>
      )}
      <PopoverContent
        className="shell-topbar-app-source__popover"
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={8}
      >
        <PopoverBody className="shell-topbar-app-source__body">
          {hasReady ? (
            <section className="shell-topbar-app-source__section">
              <h3>{t("shell.appSource.ready")}</h3>
              {state.ready.map((draft) => (
                <Row
                  key={draft.sha}
                  title={draft.subject || draft.name}
                  action={t("shell.appSource.apply")}
                  primary
                  disabled={state.busy}
                  onAction={() => void run(() => api.apply(draft.name))}
                />
              ))}
              {remoteAhead ? (
                <Row
                  title={t("shell.appSource.fromOtherComputer")}
                  detail={String(state.remote.count)}
                  action={t("shell.appSource.apply")}
                  primary
                  disabled={state.busy}
                  onAction={() => void run(() => api.applyRemote())}
                />
              ) : null}
              {upstreamAhead ? (
                <Row
                  title={t("shell.appSource.updateAvailable")}
                  detail={state.upstream.subject}
                  action={t("shell.appSource.apply")}
                  primary
                  disabled={state.busy}
                  onAction={() => void run(() => api.applyUpstream())}
                />
              ) : null}
            </section>
          ) : null}
          {hasAttention ? (
            <section className="shell-topbar-app-source__section">
              <h3>{t("shell.appSource.attention")}</h3>
              {state.stale.map((draft) => (
                <Row
                  key={draft.sha}
                  title={draft.subject || draft.name}
                  detail={t("shell.appSource.outdated")}
                  action={t("shell.appSource.ask")}
                  onAction={() =>
                    ask(t("shell.appSource.askRebase", { name: draft.name }))
                  }
                />
              ))}
              {diverged ? (
                <Row
                  title={t("shell.appSource.diverged")}
                  action={t("shell.appSource.ask")}
                  onAction={() => ask(t("shell.appSource.askMerge"))}
                />
              ) : null}
              {upstreamDiverged ? (
                <Row
                  title={t("shell.appSource.updateAvailable")}
                  detail={t("shell.appSource.updateNeedsMerge")}
                  action={t("shell.appSource.ask")}
                  onAction={() => ask(t("shell.appSource.askUpdate"))}
                />
              ) : null}
              {conflict ? (
                <Row
                  title={conflict.subject}
                  detail={t("shell.appSource.undoConflict")}
                  action={t("shell.appSource.ask")}
                  onAction={() =>
                    ask(
                      t("shell.appSource.askUndo", {
                        subject: conflict.subject,
                      }),
                    )
                  }
                />
              ) : null}
            </section>
          ) : null}
          {state.recent.length > 0 ? (
            <section className="shell-topbar-app-source__section">
              <h3>{t("shell.appSource.recent")}</h3>
              {state.recent.map((commit) => (
                <Row
                  key={commit.sha}
                  title={commit.subject}
                  detail={formatAgo(locale, commit.date)}
                  action={t("shell.appSource.undo")}
                  disabled={state.busy}
                  onAction={() =>
                    void run(
                      () => api.undo(commit.sha),
                      () => setConflictingUndo(commit.sha),
                    )
                  }
                />
              ))}
            </section>
          ) : null}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
};

const Row = (props: {
  title: string;
  detail?: string;
  action: string;
  primary?: boolean;
  disabled?: boolean;
  onAction: () => void;
}) => (
  <div className="shell-topbar-app-source__row">
    <div className="shell-topbar-app-source__text">
      <span title={props.title}>{props.title}</span>
      {props.detail ? <small>{props.detail}</small> : null}
    </div>
    <button
      type="button"
      className={props.primary ? "pill-btn pill-btn--primary" : "pill-btn"}
      disabled={props.disabled}
      onClick={props.onAction}
    >
      {props.action}
    </button>
  </div>
);
