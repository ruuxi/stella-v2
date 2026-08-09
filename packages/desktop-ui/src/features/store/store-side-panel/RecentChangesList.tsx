import { Check, Plus } from "@/ui/icons";
import {
  featureKeyOf,
  loadOlderFeatureEntries,
  storeSidePanelStore,
  type SelfModFeatureSnapshot,
  type StoreSidePanelOlderEntry,
} from "../store-side-panel-store";
import { formatTimeAgo } from "./format";
import { useLocale, useT, useTPlural } from "@/shared/i18n";

type RecentRowProps = {
  name: string;
  meta: string | null;
  selected: boolean;
  onToggle: () => void;
};

function RecentRow({ name, meta, selected, onToggle }: RecentRowProps) {
  const t = useT();
  return (
    <div
      className="store-side-panel-row"
      data-selected={selected || undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      title={
        selected
          ? t("features.store.recentChanges.rowDeselectHint")
          : t("features.store.recentChanges.rowSelectHint")
      }
    >
      <span
        className="store-side-panel-row-glyph"
        data-selected={selected || undefined}
        aria-hidden
      >
        {selected ? (
          <Check size={12} strokeWidth={2.4} />
        ) : (
          <Plus size={12} strokeWidth={2} />
        )}
      </span>
      <div className="store-side-panel-row-text">
        <span className="store-side-panel-row-title">{name}</span>
        {meta ? (
          <span className="store-side-panel-row-meta">{meta}</span>
        ) : null}
      </div>
    </div>
  );
}

function publishButtonLabel(
  selectedCount: number,
  t: (key: string, params?: Record<string, string | number>) => string,
  tPlural: (
    key: string,
    count: number,
    params?: Record<string, string | number>,
  ) => string,
): string {
  if (selectedCount === 0) {
    return t("features.store.recentChanges.publishEmpty");
  }
  const countPhrase = tPlural(
    "features.store.recentChanges.selectedCount",
    selectedCount,
  );
  return t("features.store.recentChanges.publishLabel", { countPhrase });
}

type RecentChangesListProps = {
  snapshot: SelfModFeatureSnapshot | null;
  snapshotLoading: boolean;
  selectedFeatureKeys: ReadonlySet<string>;
  olderEntries: StoreSidePanelOlderEntry[];
  rosterTotal: number | null;
  olderLoading: boolean;
  publishDisabled?: boolean;
  onPublishSelected: () => void;
};

export function RecentChangesList({
  snapshot,
  selectedFeatureKeys,
  olderEntries,
  rosterTotal,
  olderLoading,
  publishDisabled = false,
  onPublishSelected,
}: RecentChangesListProps) {
  const t = useT();
  const tPlural = useTPlural();
  const locale = useLocale();
  const items = snapshot?.items ?? [];
  const selectedCount = selectedFeatureKeys.size;
  if (items.length === 0) return null;
  const shownCount = items.length + olderEntries.length;
  const hasOlder = rosterTotal !== null && rosterTotal > shownCount;
  return (
    <div className="store-side-panel-recent">
      <div className="store-side-panel-list">
        {items.map((item, index) => {
          const key = featureKeyOf(item);
          const selected = selectedFeatureKeys.has(key);
          return (
            <RecentRow
              key={`${index}:${key}`}
              name={item.name}
              meta={
                snapshot?.generatedAt
                  ? t("features.store.recentChanges.updated", {
                      time: formatTimeAgo(snapshot.generatedAt, locale, t),
                    })
                  : null
              }
              selected={selected}
              onToggle={() => storeSidePanelStore.toggleFeature(key)}
            />
          );
        })}
        {olderEntries.map((entry) => {
          const key = featureKeyOf(entry);
          const selected = selectedFeatureKeys.has(key);
          return (
            <RecentRow
              key={key}
              name={entry.name}
              meta={t("features.store.recentChanges.updated", {
                time: formatTimeAgo(entry.lastCommitAt, locale, t),
              })}
              selected={selected}
              onToggle={() => storeSidePanelStore.toggleFeature(key)}
            />
          );
        })}
        {hasOlder ? (
          <button
            type="button"
            className="store-side-panel-show-older"
            disabled={olderLoading}
            onClick={() => void loadOlderFeatureEntries()}
          >
            {olderLoading
              ? t("common.loading")
              : t("features.store.recentChanges.showOlder")}
          </button>
        ) : null}
      </div>
      <div className="store-side-panel-publish-bar">
        <button
          type="button"
          className="store-side-panel-publish-btn"
          disabled={selectedCount === 0 || publishDisabled}
          onClick={onPublishSelected}
        >
          {publishButtonLabel(selectedCount, t, tPlural)}
        </button>
      </div>
    </div>
  );
}
