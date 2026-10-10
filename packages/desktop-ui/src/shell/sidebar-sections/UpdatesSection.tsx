import type {
  AppSourceCommit,
  AppSourceWaiting,
} from "@stella/contracts/desktop/app-source";
import { useLocale, useT } from "@/shared/i18n";
import {
  appSourceApi,
  updateProgress,
  useAppSourceState,
} from "@/features/app-source/app-source-store";
import {
  addOffer,
  ago,
  deviceLabel,
  subjectOf,
  useAppSourceAction,
  useNow,
} from "@/features/app-source/AppSourceCards";
import { EmptyState } from "@/ui/empty-state/EmptyState";
import { Check } from "@/ui/icons";
import "./updates-section.css";

/**
 * Updates — what Stella can add to this computer, and what it already added.
 *
 * Waiting: a new version of Stella, a change the user made on another
 * computer, a change ready to add. Each says what it is in plain words and
 * has Add and Skip; a skipped one moves to a quieter Skipped list, where it
 * can still be added, until something newer arrives.
 * History: what this computer took, newest first, with Undo on the user's own
 * changes (the same undo the chat's cards use). A new version is never undone
 * from here: taking it back would leave no way to take it again.
 */

const REMOTE_MERGE_SUBJECT = "Merge the changes from another computer";
const UPSTREAM_MERGE_SUBJECT = "Merge the published Stella update";

/** An undo is `Revert "<subject>"`, and undoing it nests another. */
const reverted = (subject: string): { inner: string; depth: number } => {
  const inner = /^Revert "(.*)"$/.exec(subject)?.[1];
  if (inner === undefined) return { inner: subject, depth: 0 };
  const deeper = reverted(inner);
  return { inner: deeper.inner, depth: deeper.depth + 1 };
};

const WaitingItem = ({
  offer,
  pending,
  blocked,
  onAdd,
  onSkip,
}: {
  offer: AppSourceWaiting;
  pending: boolean;
  blocked: boolean;
  onAdd: () => void;
  onSkip?: () => void;
}) => {
  const t = useT();
  const title =
    offer.kind === "version"
      ? t("shell.appSource.updates.newVersion")
      : offer.kind === "other-computer"
        ? offer.device
          ? t("shell.appSource.updates.fromDevice", { device: deviceLabel(offer.device) })
          : t("shell.appSource.updates.fromOtherComputer")
        : t("shell.appSource.updates.readyChange");
  const detail =
    offer.kind === "version"
      ? t("shell.appSource.updates.newVersionDetail")
      : subjectOf(offer.summary);
  const adding = offer.adding || pending;
  return (
    <li className="updates-section__item" data-kind={offer.kind}>
      <div className="updates-section__text">
        <div className="updates-section__title">{title}</div>
        {detail ? (
          <div className="updates-section__detail" title={detail}>
            {detail}
          </div>
        ) : null}
      </div>
      <div className="updates-section__actions">
        {adding ? (
          <span className="updates-section__status">
            {t("shell.appSource.updates.adding")}
          </span>
        ) : (
          <>
            {onSkip ? (
              <button
                type="button"
                className="updates-section__button"
                disabled={blocked}
                onClick={onSkip}
              >
                {t("shell.appSource.updates.skip")}
              </button>
            ) : null}
            <button
              type="button"
              className="updates-section__button"
              data-primary={onSkip ? "" : undefined}
              disabled={blocked}
              onClick={onAdd}
            >
              {offer.kind === "version"
                ? t("shell.appSource.update")
                : offer.kind === "other-computer"
                  ? t("shell.appSource.updates.get")
                  : t("shell.appSource.updates.add")}
            </button>
          </>
        )}
      </div>
    </li>
  );
};

const HistoryItem = ({
  commit,
  now,
  pending,
  blocked,
  onUndo,
}: {
  commit: AppSourceCommit;
  now: number;
  pending: boolean;
  blocked: boolean;
  onUndo: () => void;
}) => {
  const t = useT();
  const locale = useLocale();
  const { inner, depth } = reverted(commit.subject);
  const change = inner.startsWith(REMOTE_MERGE_SUBJECT)
    ? t("shell.appSource.updates.fromOtherComputers")
    : inner.startsWith(UPSTREAM_MERGE_SUBJECT)
      ? t("shell.appSource.updates.newVersion")
      : inner;
  const title =
    commit.kind === "version"
      ? t("shell.appSource.updates.newVersion")
      : commit.kind === "other-computer"
        ? t("shell.appSource.updates.fromOtherComputers")
        : depth % 2 === 1
          ? t("shell.appSource.updates.removed", { change })
          : change;
  const when =
    now - commit.date < 60_000
      ? t("shell.appSource.updates.justNow")
      : ago(locale, commit.date, now);
  return (
    <li className="updates-section__item" data-kind={commit.kind}>
      <div className="updates-section__text">
        <div className="updates-section__title" title={title}>
          {title}
        </div>
        <div className="updates-section__detail">{when}</div>
      </div>
      {commit.kind === "version" ? null : (
        <div className="updates-section__actions">
          {pending ? (
            <span className="updates-section__status">
              {t("shell.appSource.updates.undoing")}
            </span>
          ) : (
            <button
              type="button"
              className="updates-section__button"
              disabled={blocked}
              onClick={onUndo}
            >
              {t("shell.appSource.undo")}
            </button>
          )}
        </div>
      )}
    </li>
  );
};

export function UpdatesSection() {
  const t = useT();
  const now = useNow();
  const state = useAppSourceState();
  const api = appSourceApi();
  const { pending, run } = useAppSourceAction();
  if (
    !state ||
    !api ||
    (state.waiting.length === 0 &&
      state.skipped.length === 0 &&
      state.recent.length === 0)
  ) {
    return (
      <EmptyState
        motif="updates"
        title={t("shell.appSource.updates.upToDateTitle")}
        body={t("shell.appSource.updates.upToDateBody")}
      />
    );
  }
  const blocked =
    state.busy || pending !== null || updateProgress(state)?.state === "merging";
  return (
    <div className="updates-section sidebar-section__scroll" data-testid="updates-section">
      <h2 className="updates-section__heading">{t("shell.appSource.updates.waiting")}</h2>
      {state.waiting.length === 0 ? (
        <div className="updates-section__quiet">
          <Check size={14} strokeWidth={2} aria-hidden="true" />
          {t("shell.appSource.updates.upToDate")}
        </div>
      ) : (
        <ul className="updates-section__list" data-testid="updates-waiting">
          {state.waiting.map((offer) => (
            <WaitingItem
              key={offer.key}
              offer={offer}
              pending={pending === offer.key}
              blocked={blocked}
              onAdd={() => void run(offer.key, () => addOffer(offer))}
              onSkip={() => void run(`skip:${offer.key}`, () => api.skip(offer.key))}
            />
          ))}
        </ul>
      )}
      {state.skipped.length > 0 ? (
        <>
          <h2 className="updates-section__heading">{t("shell.appSource.updates.skipped")}</h2>
          <ul className="updates-section__list" data-testid="updates-skipped">
            {state.skipped.map((offer) => (
              <WaitingItem
                key={offer.key}
                offer={offer}
                pending={pending === offer.key}
                blocked={blocked}
                onAdd={() => void run(offer.key, () => addOffer(offer))}
              />
            ))}
          </ul>
        </>
      ) : null}
      {state.recent.length > 0 ? (
        <>
          <h2 className="updates-section__heading">{t("shell.appSource.updates.history")}</h2>
          <ul className="updates-section__list" data-testid="updates-history">
            {state.recent.map((commit) => (
              <HistoryItem
                key={commit.sha}
                commit={commit}
                now={now}
                pending={pending === `undo:${commit.sha}`}
                blocked={blocked}
                onUndo={() => void run(`undo:${commit.sha}`, () => api.undo(commit.sha))}
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
