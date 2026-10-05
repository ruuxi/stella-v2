import { useCallback, useEffect } from "react";
import type { AppSourceActionResult } from "@stella/contracts/desktop/app-source";
import { RefreshCw } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import {
  appSourceApi,
  clearUpdateMerge,
  handOffToAgent,
  officialUpdate,
  requestUpdateMerge,
  runAppSourceAction,
  useAppSourceState,
  usePendingAppSourceAction,
  useUpdateMergeRequested,
} from "@/features/app-source/app-source-store";
import "./shell-topbar-update-pill.css";

const KEY = "upstream";

/**
 * Official Stella updates (the published app), one click: the pill shows
 * once a new version is fetched and pressing it takes it. When the user has
 * changed Stella, an agent merges the update with their changes in the
 * background and the merge is taken as soon as it is ready; nothing asks.
 * Changes the user asked Stella to make are the chat's (`AppSourceCards`).
 */
export const ShellTopBarUpdatePill = () => {
  const t = useT();
  const state = useAppSourceState();
  const pending = usePendingAppSourceAction();
  const merging = useUpdateMergeRequested();
  const api = appSourceApi();
  const update = state ? officialUpdate(state) : null;

  const take = useCallback(
    async (action: () => Promise<AppSourceActionResult>) => {
      const result = await runAppSourceAction(KEY, action);
      if (result.ok) return;
      showToast({
        title: t("shell.appSource.failed"),
        description: result.error,
        variant: "error",
      });
    },
    [t],
  );

  // The merge pressing Update started is ready: take it.
  const merged = update?.kind === "merged" ? update.draft.name : null;
  useEffect(() => {
    if (!merging || !merged || !api) return;
    clearUpdateMerge();
    void take(() => api.apply(merged));
  }, [api, merged, merging, take]);

  if (!state || !api || !update) return null;
  const updating = pending === KEY || (merging && update.kind === "diverged");
  const label = updating ? t("shell.appSource.updating") : t("shell.appSource.update");
  const onClick = () => {
    if (update.kind === "merged") void take(() => api.apply(update.draft.name));
    else if (update.kind === "ahead") void take(() => api.applyUpstream());
    else {
      requestUpdateMerge();
      handOffToAgent(t("shell.appSource.askUpdate"));
    }
  };

  return (
    <div
      className="shell-topbar-update-pill"
      data-state={updating ? "updating" : "ready"}
      data-update-transition={updating ? "live" : undefined}
    >
      <button
        type="button"
        className="shell-topbar-update-pill__main"
        onClick={onClick}
        disabled={updating || state.busy || pending !== null}
        aria-label={label}
        title={t("shell.appSource.updateAvailable")}
      >
        <RefreshCw
          className="shell-topbar-update-pill__icon"
          size={12}
          strokeWidth={2}
          aria-hidden
        />
        <span className="shell-topbar-update-pill__label">{label}</span>
      </button>
    </div>
  );
};
