import { Check } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import "./EngineScopedModelList.css";
export function EngineScopedModelList({ engineLabel, models, value, onSelect, loading = false, disabled = false, emptyMessage, hideHead = false, selectedRowExtra = null, }) {
    const t = useT();
    return (<div className="engine-scoped-model-list" aria-label={t("settings.engineModels.ariaLabel", { engine: engineLabel })}>
      {hideHead ? null : (<div className="engine-scoped-model-list__head">
          <span>{engineLabel}</span>
        </div>)}
      <div className="engine-scoped-model-list__rows">
        {loading && models.length === 0 ? (<p>{t("settings.engineModels.loading", { engine: engineLabel })}</p>) : models.length === 0 ? (emptyMessage === null ? null : (<p>{emptyMessage ?? t("settings.engineModels.empty", { engine: engineLabel })}</p>)) : (models.map((model) => {
            const selected = model.id === value;
            return (<div key={model.id} className="engine-scoped-model-list__row-slot">
                <button type="button" aria-pressed={selected} aria-disabled={model.unavailable || undefined} data-selected={selected || undefined} disabled={disabled || model.unavailable} onClick={() => onSelect(model.id)}>
                  <span className="engine-scoped-model-list__text">
                    <span className="engine-scoped-model-list__name">
                      {model.label}
                    </span>
                    {model.description ? (<span className="engine-scoped-model-list__description">
                        {model.description}
                      </span>) : null}
                  </span>
                  {selected ? (<Check size={13} className="engine-scoped-model-list__check" aria-hidden/>) : null}
                </button>
                {selected && selectedRowExtra ? (<div className="model-picker-selected-extra">{selectedRowExtra}</div>) : null}
              </div>);
        }))}
      </div>
    </div>);
}
