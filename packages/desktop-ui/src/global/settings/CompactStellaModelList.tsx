import { useMemo } from "react";
import { Check } from "@/ui/icons";
import {
  getStellaDisplayName,
  getStellaSubtitle,
  type CatalogModel,
} from "@/global/settings/lib/model-catalog";
import { useT } from "@/shared/i18n";
import "./CompactStellaModelList.css";

export interface CompactModelListEntry {
  id: string;
  label: string;
  subtitle?: string;

  unavailable?: boolean;
}

interface CompactStellaModelListProps {

  stellaModels: readonly CatalogModel[];

  value: string;

  recents?: readonly CompactModelListEntry[];

  defaultLabel: string;

  onSelect: (value: string) => void;
  disabled?: boolean;

  loading?: boolean;

  error?: string | null;

  onRetry?: () => void;

  restricted?: boolean;
  restrictedPlanLabel?: string | null;
  onUpgrade?: () => void;
}

export function CompactStellaModelList({
  stellaModels,
  value,
  recents = [],
  defaultLabel,
  onSelect,
  disabled = false,
  loading = false,
  error = null,
  onRetry,
  restricted = false,
  restrictedPlanLabel,
  onUpgrade,
}: CompactStellaModelListProps) {
  const t = useT();
  const presets = useMemo(
    () =>
      stellaModels.filter(
        (model) =>
          model.provider === "stella" &&
          model.id.startsWith("stella/") &&

          !model.modelId.includes("/"),
      ),
    [stellaModels],
  );

  const isDefaultSelected = !value;

  return (
    <div
      className="compact-stella-list"
      role="listbox"
      aria-label={t("settings.compactModelList.ariaLabel")}
    >
      {recents.length > 0 ? (
        <>
          <div className="compact-stella-list-heading">
            {t("settings.compactModelList.recent")}
          </div>
          {recents.map((entry) => {
            const selected = entry.id === value;
            const subtitle = entry.unavailable
              ? t("settings.compactModelList.unavailable")
              : entry.subtitle;
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={entry.unavailable || undefined}
                className="compact-stella-list-item"
                data-selected={selected || undefined}
                data-restricted={entry.unavailable || undefined}
                title={
                  entry.unavailable
                    ? t("settings.compactModelList.unavailableTitle")
                    : undefined
                }
                onClick={() => onSelect(entry.id)}
                disabled={disabled || entry.unavailable}
              >
                <span className="compact-stella-list-item-text">
                  <span className="compact-stella-list-item-name">
                    {entry.label}
                  </span>
                  {subtitle ? (
                    <span className="compact-stella-list-item-sub">
                      {subtitle}
                    </span>
                  ) : null}
                </span>
                {selected ? (
                  <Check size={13} className="compact-stella-list-item-check" />
                ) : null}
              </button>
            );
          })}
          <div className="compact-stella-list-divider" role="presentation" />
        </>
      ) : null}
      <button
        type="button"
        role="option"
        aria-selected={isDefaultSelected}
        className="compact-stella-list-item compact-stella-list-item--default"
        data-selected={isDefaultSelected || undefined}
        onClick={() => onSelect("")}
        disabled={disabled}
      >
        <span className="compact-stella-list-item-name">{defaultLabel}</span>
        {isDefaultSelected ? (
          <Check size={13} className="compact-stella-list-item-check" />
        ) : null}
      </button>
      {presets.length === 0 ? (
        loading ? (
          <div className="compact-stella-list-empty">
            {t("settings.compactModelList.loading")}
          </div>
        ) : (
          <div className="compact-stella-list-empty compact-stella-list-empty--state">
            <span>
              {error
                ? t("settings.compactModelList.loadFailed")
                : t("settings.compactModelList.empty")}
            </span>
            {onRetry ? (
              <button
                type="button"
                className="compact-stella-list-restricted-link"
                onClick={onRetry}
              >
                {t("settings.compactModelList.retry")}
              </button>
            ) : null}
          </div>
        )
      ) : (
        presets.map((model) => {
          const selected = !isDefaultSelected && model.id === value;
          const subtitle = getStellaSubtitle(model);

          const rowRestricted =
            restricted && !selected && model.allowedForAudience === false;
          return (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={rowRestricted || undefined}
              className="compact-stella-list-item"
              data-selected={selected || undefined}
              data-restricted={rowRestricted || undefined}
              title={
                rowRestricted && restrictedPlanLabel
                  ? t("settings.modelPicker.restrictedPlan", {
                      plan: restrictedPlanLabel,
                    })
                  : undefined
              }
              onClick={() => onSelect(model.id)}
              disabled={disabled || rowRestricted}
            >
              <span className="compact-stella-list-item-text">
                <span className="compact-stella-list-item-name">
                  {getStellaDisplayName(model)}
                </span>
                {subtitle ? (
                  <span className="compact-stella-list-item-sub">
                    {subtitle}
                  </span>
                ) : null}
              </span>
              {selected ? (
                <Check size={13} className="compact-stella-list-item-check" />
              ) : null}
            </button>
          );
        })
      )}
      {restricted ? (
        <div className="compact-stella-list-restricted">
          <span>
            {restrictedPlanLabel
              ? t("settings.compactModelList.restrictedPlan", {
                  plan: restrictedPlanLabel,
                })
              : t("settings.compactModelList.restricted")}
          </span>
          {onUpgrade ? (
            <button
              type="button"
              className="compact-stella-list-restricted-link"
              onClick={onUpgrade}
            >
              {t("settings.compactModelList.upgrade")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
