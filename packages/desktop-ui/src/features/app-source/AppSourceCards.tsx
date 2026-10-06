import { memo, type ReactNode, useEffect, useState } from "react";
import {
  type AppSourceActionResult,
  type AppSourceDraft,
  isStellaDraft,
} from "@stella/contracts/desktop/app-source";
import { GrowIn } from "@/app/chat/GrowIn";
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
 * on the message that relays its completion (Update, then Undo), and on the
 * user's other computers the same message offers to add the change there.
 * Changes no agent here made (by hand, or from another computer outside this
 * chat) pin above the composer. Official updates are the top bar's
 * (`ShellTopBarUpdatePill`). Nothing renders unless Stella runs from source.
 */

/** Re-render every half minute so "Updated 3 minutes ago" stays true. */
const useNow = () => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
};

const ago = (locale: string, date: number, now: number) => {
  const minutes = Math.round((date - now) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
};

/** Undos are `Revert "<subject>"` (and undos of undos nest); show the change. */
const subjectOf = (subject: string): string => {
  const inner = /^Revert "(.*)"$/.exec(subject)?.[1];
  return inner === undefined ? subject : subjectOf(inner);
};

/**
 * Runs card actions: `pending` names the card whose action is running (in any
 * mounted copy). Only a real failure is shown; work that moved to the
 * background succeeded, and the state says so.
 */
const useAction = () => {
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
  const { pending: running, run } = useAction();
  const api = appSourceApi();
  const change = state ? agentChange(state, agentId) : null;
  if (!state || !api || !change) return null;
  const pending = running === agentId;
  // Nothing else goes in while Stella is settling its own version: a change
  // applied into the middle of that merge is a conflict nobody asked for.
  const blocked =
    updateProgress(state)?.state === "merging" ||
    ((state.busy || running !== null) && !pending);

  if (change.kind === "elsewhere") {
    // Made on another computer: it never applies here on its own, and it isn't
    // an official update, so it doesn't say Update.
    const { change: other } = change;
    const title = other.device
      ? t("shell.appSource.changedOn", { device: other.device })
      : t("shell.appSource.changedElsewhere");
    if (other.here) {
      return (
        <UpdateCard tone="done" title={title} detail={t("shell.appSource.added")} action={null} />
      );
    }
    return (
      <UpdateCard
        tone="update"
        title={title}
        detail={t("shell.appSource.addPrompt")}
        busy={pending}
        disabled={blocked}
        action={{
          label: t("shell.appSource.addHere"),
          primary: true,
          onClick: () => void run(agentId, () => api.applyRemote()),
        }}
      />
    );
  }

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

type Offer = { key: string; node: ReactNode };

/**
 * Offers that just left (applied, or gone from the state) stay rendered,
 * shrinking away, so the composer below glides instead of jumping.
 */
const useLeavingOffers = (offers: Offer[]) => {
  const keys = offers.map((offer) => offer.key).join("\n");
  const [seen, setSeen] = useState({
    keys,
    nodes: new Map(offers.map((offer) => [offer.key, offer.node])),
    leaving: new Map<string, ReactNode>(),
  });
  let current = seen;
  if (seen.keys !== keys) {
    const present = new Set(offers.map((offer) => offer.key));
    const leaving = new Map([...seen.leaving].filter(([key]) => !present.has(key)));
    for (const [key, node] of seen.nodes) if (!present.has(key)) leaving.set(key, node);
    current = { keys, nodes: new Map(offers.map((offer) => [offer.key, offer.node])), leaving };
    setSeen(current);
  }
  const { leaving } = current;
  useEffect(() => {
    if (leaving.size === 0) return;
    const timer = window.setTimeout(
      () => setSeen((state) => ({ ...state, leaving: new Map() })),
      700,
    );
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return [
    ...offers.map((offer) => ({ ...offer, show: true })),
    ...[...leaving].map(([key, node]) => ({ key, node, show: false })),
  ];
};

/**
 * Changes no agent here made: drafts made by hand, other computers. Plus the
 * one line Stella's own version work gets while it happens — that is
 * genuinely unlike updating anything else, so it says the least it can: that
 * it is happening, and then that it is done. Never why it takes a while, and
 * never that anything clashed.
 */
export const AppSourceOffers = memo(function AppSourceOffers() {
  const t = useT();
  const tPlural = useTPlural();
  const state = useAppSourceState();
  const { pending, run } = useAction();
  const api = appSourceApi();
  const offers: Offer[] = [];
  if (state && api) {
    const blocked = state.busy && pending === null;
    const offer = (
      key: string,
      card: Omit<Parameters<typeof UpdateCard>[0], "placement" | "busy" | "disabled">,
    ) =>
      offers.push({
        key,
        node: (
          <UpdateCard
            {...card}
            placement="composer"
            busy={pending === key}
            disabled={blocked || (pending !== null && pending !== key)}
          />
        ),
      });
    const progress = updateProgress(state);
    if (progress) {
      offer("update", {
        tone: progress.state === "done" ? "done" : "update",
        title:
          progress.state === "done"
            ? t("shell.appSource.upToDate")
            : t("shell.appSource.updatingInBackground"),
        action: null,
      });
    }
    // While that merge is going on, nothing else is offered: applying another
    // change into the middle of it is how you get a conflict nobody asked for.
    if (progress?.state !== "merging") {
      const byHand = (entry: AppSourceDraft) =>
        !entry.agentId && !isStellaDraft(entry.name);
      // A draft whose base moved offers the same button: the main process
      // merges it, and only a real conflict in it reaches an agent.
      for (const draft of [...state.ready, ...state.stale].filter(byHand)) {
        const outdated = state.stale.includes(draft);
        const key = `${outdated ? "stale" : "ready"}:${draft.sha}`;
        offer(key, {
          tone: "update",
          title: draft.subject || draft.name,
          detail: outdated
            ? t("shell.appSource.outdated")
            : `${t("shell.appSource.title")} · ${
                draft.restart
                  ? t("shell.appSource.restarts")
                  : tPlural("shell.appSource.files", draft.files)
              }`,
          action: {
            label: t("shell.appSource.update"),
            primary: true,
            onClick: () => void run(key, () => api.apply(draft.name)),
          },
        });
      }
      // Another computer's changes, unless an agent's change in the chat
      // already offers them (adding it takes them all).
      if (
        state.remote.status !== "none" &&
        !state.elsewhere.some((change) => !change.here)
      ) {
        offer("remote", {
          tone: "update",
          title: t("shell.appSource.changedElsewhere"),
          detail: tPlural("shell.appSource.changes", state.remote.count),
          action: {
            label: t("shell.appSource.addHere"),
            primary: true,
            onClick: () => void run("remote", () => api.applyRemote()),
          },
        });
      }
    }
  }
  return <OffersList offers={offers} />;
});

const OffersList = ({ offers }: { offers: Offer[] }) => {
  const shown = useLeavingOffers(offers);
  if (shown.length === 0) return null;
  return (
    <div className="app-update-offers">
      {shown.map((offer) => (
        <GrowIn key={offer.key} show={offer.show} duration={420}>
          {offer.node}
        </GrowIn>
      ))}
    </div>
  );
};
