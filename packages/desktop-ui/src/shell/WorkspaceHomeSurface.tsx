import { createPortal } from "react-dom";
import { useT } from "@/shared/i18n";
import { useLayoutEffect, useState } from "react";
import { HomeSection } from "@/shell/sidebar-sections/HomeSection";
import { useHasQualifyingActivity } from "@/shell/workspace/use-qualifying-activity";
import { usePendingCloudBrowserInteractions } from "@/features/cloud/use-cloud-browser-interactions";
import "./workspace-home-surface.css";

type WorkspaceHomeSurfaceProps = {
  hidden: boolean;
  portalTarget?: Element | null;
};

/**
 * The always-available Activity surface beside the main app.
 *
 * This is deliberately a sibling of RightSidebar, not one of its sections.
 * Opening the sidebar collapses this surface and replaces it with the panel;
 * closing the sidebar reveals Activity again.
 */
export function WorkspaceHomeSurface({
  hidden,
  portalTarget,
}: WorkspaceHomeSurfaceProps) {
  const t = useT();
  // Authoritative "is anything legitimately on the right?" signal: the count of
  // Activity rows that actually qualify to be shown (running + terminal rows
  // inside their auto-hide window), NOT the raw conversation task count — the
  // latter stays > 0 after every row has auto-hidden, which reserved an empty
  // gutter here. Shared with WorkspaceSections so the strip and its list agree.
  const hasActivity = useHasQualifyingActivity();
  const hasNeedsYou = usePendingCloudBrowserInteractions().length > 0;
  const hasRightContent = hasActivity || hasNeedsYou;
  const [settledHasActivity, setSettledHasActivity] = useState(hasRightContent);
  const activityAvailabilityChanging = settledHasActivity !== hasRightContent;

  useLayoutEffect(() => {
    if (!activityAvailabilityChanging) return;
    const frame = window.requestAnimationFrame(() => {
      setSettledHasActivity(hasRightContent);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activityAvailabilityChanging, hasRightContent]);
  // The Models control now lives globally in the shell (GlobalModelsControl),
  // so this strip only exists to show ambient activity.
  const surfaceHidden = hidden || !hasRightContent;
  const resolvedPortalTarget =
    portalTarget ?? document.querySelector(".full-body") ?? document.body;

  return createPortal(
    <aside
      className="workspace-home-surface"
      data-hidden={surfaceHidden ? "true" : "false"}
      data-activity-availability-changing={
        activityAvailabilityChanging ? "true" : undefined
      }
      aria-label={t("shell.workspace.activity")}
      aria-hidden={surfaceHidden}
      inert={surfaceHidden}
    >
      <div className="workspace-home-surface__inner">
        <div className="workspace-home-surface__body">
          <div className="workspace-home-surface__activity">
            <HomeSection />
          </div>
        </div>
      </div>
    </aside>,
    resolvedPortalTarget,
  );
}
