import { useCallback } from "react";
import type { AppSourceActionResult } from "@stella/contracts/desktop/app-source";
import { RefreshCw } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import {
  appSourceApi,
  officialUpdate,
  runAppSourceAction,
  updateProgress,
  useAppSourceState,
  usePendingAppSourceAction,
} from "@/features/app-source/app-source-store";
import "./shell-topbar-update-pill.css";

const KEY = "upstream";

/**
 * Official Stella updates (the published app), one click: the pill shows
 * once a new version is fetched and pressing it takes it. Whether that means
 * a fast-forward, a merge with the user's own changes, or a merge an agent
 * has to look at is decided in the main process and never asked about here;
 * pressing the pill is the whole conversation. Changes the user asked Stella
 * to make are the chat's (`AppSourceCards`).
 */
export const ShellTopBarUpdatePill = () => {
  const t = useT();
  const state = useAppSourceState();
  const pending = usePendingAppSourceAction();
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

  if (!state || !api || !update) return null;
  const updating =
    pending === KEY || updateProgress(state)?.state === "merging";
  const label = updating ? t("shell.appSource.updating") : t("shell.appSource.update");
  // A merge an agent finished while the app was restarted is sitting there as
  // a draft; otherwise the main process works out what taking it means.
  const onClick = () =>
    update.kind === "merged"
      ? void take(() => api.apply(update.draft.name))
      : void take(() => api.applyUpstream());

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
