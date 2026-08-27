import { createPortal } from "react-dom";
import { useT } from "@/shared/i18n";
import { useLayoutEffect, useState } from "react";
import { HomeSection } from "@/shell/sidebar-sections/HomeSection";
import { useHasQualifyingActivity } from "@/shell/workspace/use-qualifying-activity";
import "./workspace-home-surface.css";

type WorkspaceHomeSurfaceProps = {
  hidden: boolean;
  portalTarget?: Element | null;
};

export function WorkspaceHomeSurface({
  hidden,
  portalTarget,
}: WorkspaceHomeSurfaceProps) {
  const t = useT();

  const hasActivity = useHasQualifyingActivity();
  const [settledHasActivity, setSettledHasActivity] = useState(hasActivity);
  const activityAvailabilityChanging = settledHasActivity !== hasActivity;

  useLayoutEffect(() => {
    if (!activityAvailabilityChanging) return;
    const frame = window.requestAnimationFrame(() => {
      setSettledHasActivity(hasActivity);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activityAvailabilityChanging, hasActivity]);

  const surfaceHidden = hidden || !hasActivity;
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
