import { createPortal } from "react-dom";
import { useT } from "@/shared/i18n";
import { useLayoutEffect, useState } from "react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { HomeSection } from "@/shell/sidebar-sections/HomeSection";
import { SidebarModelsControl } from "@/shell/sidebar-sections/SidebarModelsControl";
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
  const chat = useChatRuntime();
  const hasActivity = chat.conversation.tasks.length > 0;
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
        {/* Models only. The rest of the utility cluster (Theme, Phone,
            Connectors, Feedback) stays in the panel's Home footer — this
            strip is for activity, and a second copy of those triggers just
            crowded it. `active` hands the shared Models popover to
            whichever footer is actually visible, since both mount at once
            and read the same engine-overlay store. */}
        <div className="workspace-home-surface__footer">
          <SidebarModelsControl active={!surfaceHidden} />
        </div>
      </div>
    </aside>,
    resolvedPortalTarget,
  );
}
