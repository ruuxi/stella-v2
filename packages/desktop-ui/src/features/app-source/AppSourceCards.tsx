import { memo, useEffect, useState } from "react";
import type { AppSourceActionResult } from "@stella/contracts/desktop/app-source";
import { showToast } from "@/ui/toast";
import { useLocale, useT, useTPlural } from "@/shared/i18n";
import {
  agentChange,
  appSourceApi,
  runAppSourceAction,
  updateProgress,
  useAppSourceState,
  usePendingAppSourceAction,
} from "./app-source-store";
import { UpdateCard } from "./UpdateCard";

/**
 * Changes the user asked Stella to make, in the chat: an agent's draft shows
 * on the message that relays its completion (Update, then Undo). Everything
 * else that can be added (a new version, a change from another computer, a
 * draft made by hand) is the Updates list's (`UpdatesSection`), opened from
 * the pill above the composer. Nothing renders unless Stella runs from source.
 */

/** Re-render every half minute so "Updated 3 minutes ago" stays true. */
export const useNow = () => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
};

export const ago = (locale: string, date: number, now: number) => {
  const minutes = Math.round((date - now) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
};

/** Undos are `Revert "<subject>"` (and undos of undos nest); show the change. */
export const subjectOf = (subject: string): string => {
  const inner = /^Revert "(.*)"$/.exec(subject)?.[1];
  return inner === undefined ? subject : subjectOf(inner);
};

/**
 * Runs card actions: `pending` names the card whose action is running (in any
 * mounted copy). Only a real failure is shown; work that moved to the
 * background succeeded, and the state says so.
 */
export const useAppSourceAction = () => {
  const t = useT();
  const pending = usePendingAppSourceAction();
  const run = async (
    key: string,
    action: () => Promise<AppSourceActionResult>,
  ) => {
    const result = await runAppSourceAction(key, action);
    if (result.ok) return;
    showToast({
      title: t("shell.appSource.failed"),
      description: result.error,
      variant: "error",
    });
  };
  return { pending, run };
};

export const AgentUpdateCard = memo(function AgentUpdateCard({
  agentId,
}: {
  agentId: string;
}) {
  const t = useT();
  const tPlural = useTPlural();
  const locale = useLocale();
  const now = useNow();
  const state = useAppSourceState();
  const { pending: running, run } = useAppSourceAction();
  const api = appSourceApi();
  const change = state ? agentChange(state, agentId) : null;
  if (!state || !api || !change) return null;
  const pending = running === agentId;
  // Nothing else goes in while Stella is settling its own version: a change
  // applied into the middle of that merge is a conflict nobody asked for.
  const blocked =
    updateProgress(state)?.state === "merging" ||
    ((state.busy || running !== null) && !pending);

  if (change.kind === "ready" || change.kind === "stale") {
    const { draft } = change;
    const stale = change.kind === "stale";
    const shape = draft.restart
      ? t("shell.appSource.restarts")
      : tPlural("shell.appSource.files", draft.files);
    return (
      <UpdateCard
        tone="update"
        title={draft.subject || draft.name}
        detail={stale ? t("shell.appSource.outdated") : `${t("shell.appSource.title")} · ${shape}`}
        busy={pending}
        disabled={blocked}
        action={{
          label: t("shell.appSource.update"),
          primary: true,
          // Including a draft whose base moved: the main process merges it,
          // and only involves an agent if that genuinely conflicts.
          onClick: () => void run(agentId, () => api.apply(draft.name)),
        }}
      />
    );
  }

  const { commit } = change;
  const subject = subjectOf(commit.subject);
  const recent = now - commit.date < 60_000;
  const when = ago(locale, commit.date, now);
  return (
    <UpdateCard
      tone={commit.undone ? "update" : "done"}
      title={subject}
      detail={
        commit.undone
          ? recent
            ? t("shell.appSource.undoneJustNow")
            : t("shell.appSource.undoneAgo", { ago: when })
          : recent
            ? t("shell.appSource.updatedJustNow")
            : t("shell.appSource.updatedAgo", { ago: when })
      }
      busy={pending}
      disabled={blocked}
      action={{
        // Undoing an undo takes the change again.
        label: commit.undone ? t("shell.appSource.update") : t("shell.appSource.undo"),
        primary: commit.undone,
        // An undo later work conflicts with goes to an agent, which finishes
        // it as a draft this card then offers.
        onClick: () => void run(agentId, () => api.undo(commit.sha)),
      }}
    />
  );
});
