import { memo, type ReactNode, useEffect, useState } from "react";
import type { AppSourceActionResult } from "@stella/contracts/desktop/app-source";
import { GrowIn } from "@/app/chat/GrowIn";
import { showToast } from "@/ui/toast";
import { dispatchStellaSendMessage } from "@/shared/lib/stella-send-message";
import { useLocale, useT, useTPlural } from "@/shared/i18n";
import {
  agentChange,
  appSourceApi,
  runAppSourceAction,
  useAppSourceState,
  usePendingAppSourceAction,
} from "./app-source-store";
import { UpdateCard } from "./UpdateCard";

/**
 * Changes to Stella in the chat, where the user asked for them: an agent's
 * draft shows on the message that relays its completion (Update, then
 * Undo); changes no agent made here (the user's other computers, a new
 * published version) pin above the composer. Nothing renders unless Stella
 * runs from source.
 */

const ask = (text: string) => dispatchStellaSendMessage({ text }, { openPanel: false });

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
 * mounted copy). Failures toast; conflicts go to `onConflict`.
 */
const useAction = () => {
  const t = useT();
  const pending = usePendingAppSourceAction();
  const run = async (
    key: string,
    action: () => Promise<AppSourceActionResult>,
    onConflict?: () => void,
  ) => {
    const result = await runAppSourceAction(key, action);
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
  const [conflict, setConflict] = useState<string | null>(null);
  const api = appSourceApi();
  const change = state ? agentChange(state, agentId) : null;
  if (!state || !api || !change) return null;
  const pending = running === agentId;
  const blocked = (state.busy || running !== null) && !pending;

  if (change.kind === "ready" || change.kind === "stale") {
    const { draft } = change;
    const stale = change.kind === "stale";
    const shape = draft.restart
      ? t("shell.appSource.restarts")
      : tPlural("shell.appSource.files", draft.files);
    return (
      <UpdateCard
        tone={stale ? "attention" : "update"}
        title={draft.subject || draft.name}
        detail={stale ? t("shell.appSource.outdated") : `${t("shell.appSource.title")} · ${shape}`}
        busy={pending}
        disabled={blocked}
        action={
          stale
            ? {
                label: t("shell.appSource.ask"),
                onClick: () => ask(t("shell.appSource.askRebase", { name: draft.name })),
              }
            : {
                label: t("shell.appSource.update"),
                primary: true,
                onClick: () => void run(agentId, () => api.apply(draft.name)),
              }
        }
      />
    );
  }

  const { commit } = change;
  const subject = subjectOf(commit.subject);
  if (conflict === commit.sha) {
    return (
      <UpdateCard
        tone="attention"
        title={subject}
        detail={t("shell.appSource.undoConflict")}
        action={{
          label: t("shell.appSource.ask"),
          onClick: () => ask(t("shell.appSource.askUndo", { subject })),
        }}
      />
    );
  }
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
        onClick: () => void run(agentId, () => api.undo(commit.sha), () => setConflict(commit.sha)),
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

/** Changes no agent here made: drafts made by hand, other computers, published updates. */
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
    for (const draft of state.ready.filter((entry) => !entry.agentId)) {
      const key = `ready:${draft.sha}`;
      offer(key, {
        tone: "update",
        title: draft.subject || draft.name,
        detail: `${t("shell.appSource.title")} · ${
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
    for (const draft of state.stale.filter((entry) => !entry.agentId)) {
      offer(`stale:${draft.sha}`, {
        tone: "attention",
        title: draft.subject || draft.name,
        detail: t("shell.appSource.outdated"),
        action: {
          label: t("shell.appSource.ask"),
          onClick: () => ask(t("shell.appSource.askRebase", { name: draft.name })),
        },
      });
    }
    if (state.remote.status !== "none") {
      const diverged = state.remote.status === "diverged";
      offer("remote", {
        tone: diverged ? "attention" : "update",
        title: diverged
          ? t("shell.appSource.diverged")
          : t("shell.appSource.fromOtherComputer"),
        detail: tPlural("shell.appSource.changes", state.remote.count),
        action: diverged
          ? { label: t("shell.appSource.ask"), onClick: () => ask(t("shell.appSource.askMerge")) }
          : {
              label: t("shell.appSource.update"),
              primary: true,
              onClick: () => void run("remote", () => api.applyRemote()),
            },
      });
    }
    if (state.upstream.status !== "none") {
      const diverged = state.upstream.status === "diverged";
      offer("upstream", {
        tone: diverged ? "attention" : "update",
        title: t("shell.appSource.updateAvailable"),
        detail: diverged ? t("shell.appSource.updateNeedsMerge") : state.upstream.subject,
        action: diverged
          ? { label: t("shell.appSource.ask"), onClick: () => ask(t("shell.appSource.askUpdate")) }
          : {
              label: t("shell.appSource.update"),
              primary: true,
              onClick: () => void run("upstream", () => api.applyUpstream()),
            },
      });
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
