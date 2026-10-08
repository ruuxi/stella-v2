import { memo, useEffect, useState } from "react";
import type {
  AppSourceActionResult,
  AppSourceWaiting,
} from "@stella/contracts/desktop/app-source";
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
import "./app-update-message.css";

/**
 * Changes to Stella in the chat: an agent's draft shows on the message that
 * relays its completion (Update, then Undo), and changes no agent here made
 * (one from another computer, a draft made by hand) pin above the composer.
 * New versions from the Stella team are the top bar's
 * (`ShellTopBarUpdatePill`). The Updates tab (`UpdatesSection`) lists all of
 * them with their history. Nothing renders unless Stella runs from source.
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

/** "Rahuls-MacBook-Air" reads as "Rahuls MacBook Air". */
export const deviceLabel = (device: string) =>
  device.replace(/[-_]+/g, " ").trim();

/**
 * What adding an offer takes. A new version may already be merged with the
 * user's own changes as a draft; otherwise the main process works out what
 * taking it means.
 */
export const addOffer = (offer: AppSourceWaiting) => {
  const api = appSourceApi();
  if (!api) return Promise.resolve<AppSourceActionResult>({ ok: false, error: "" });
  if (offer.kind === "version") {
    return offer.draft ? api.apply(offer.draft) : api.applyUpstream();
  }
  if (offer.kind === "other-computer") return api.applyRemote();
  return api.apply(offer.name);
};

/**
 * Changes waiting to be added that aren't the Stella team's: a change the
 * user made on another computer, or a draft made by hand. Each is a message
 * from Stella in the chat, in the assistant's own bubble, with one button;
 * skipping one is the Updates tab's.
 */
export const AppSourceOffers = memo(function AppSourceOffers() {
  const t = useT();
  const state = useAppSourceState();
  const { pending, run } = useAppSourceAction();
  if (!state || !appSourceApi()) return null;
  // While Stella merges its own update, nothing else goes in: applying
  // another change into the middle of it is a conflict nobody asked for.
  const merging = updateProgress(state)?.state === "merging";
  const offers = state.waiting.filter(
    (offer): offer is Exclude<AppSourceWaiting, { kind: "version" }> =>
      offer.kind !== "version" && (!merging || offer.adding),
  );
  if (offers.length === 0) return null;
  const blocked = state.busy || pending !== null || merging;
  return (
    <div className="app-update-messages" data-testid="app-source-offers">
      {offers.map((offer) => {
        const adding = offer.adding || pending === offer.key;
        return (
          <div key={offer.key} className="event-row event-row--assistant">
            <div className="event-item assistant">
              <div className="message-line message-line--assistant">
                <div className="assistant-message-text chat-bubble-text app-update-message">
                  <p className="app-update-message__title">
                    {offer.kind === "other-computer"
                      ? offer.device
                        ? t("shell.appSource.updates.fromDevice", {
                            device: deviceLabel(offer.device),
                          })
                        : t("shell.appSource.updates.fromOtherComputer")
                      : t("shell.appSource.updates.readyChange")}
                  </p>
                  <p className="app-update-message__summary">
                    {subjectOf(offer.summary)}
                  </p>
                  <button
                    type="button"
                    className="app-update-message__button"
                    disabled={adding || blocked}
                    onClick={() => void run(offer.key, () => addOffer(offer))}
                  >
                    {adding
                      ? t("shell.appSource.updates.adding")
                      : offer.kind === "other-computer"
                        ? t("shell.appSource.updates.get")
                        : t("shell.appSource.updates.add")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});
