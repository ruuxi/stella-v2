import { createPortal } from "react-dom";
import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useEngineOverlayMode, useEngineOverlayOpen } from "@/shell/display/engine-overlay-store";
import { HomeSection } from "@/shell/sidebar-sections/HomeSection";
import { SidebarModelsControl } from "@/shell/sidebar-sections/SidebarModelsControl";
import { preloadModelsPicker } from "@/shell/topbar/nav-surface-preloads";
import "./workspace-home-surface.css";
const AgentModelPicker = lazy(() => import("@/global/settings/AgentModelPicker").then((module) => ({
    default: module.AgentModelPicker,
})));
/**
 * The always-available Activity surface beside the main app.
 *
 * This is deliberately a sibling of RightSidebar, not one of its sections.
 * Opening the sidebar collapses this surface and replaces it with the panel;
 * closing the sidebar reveals Activity again.
 */
export function WorkspaceHomeSurface({ hidden, portalTarget, }) {
    const chat = useChatRuntime();
    const modelsOpen = useEngineOverlayOpen();
    const modelsMode = useEngineOverlayMode();
    const hasActivity = chat.conversation.tasks.length > 0;
    const [settledHasActivity, setSettledHasActivity] = useState(hasActivity);
    const activityAvailabilityChanging = settledHasActivity !== hasActivity;
    useLayoutEffect(() => {
        if (!activityAvailabilityChanging)
            return;
        const frame = window.requestAnimationFrame(() => {
            setSettledHasActivity(hasActivity);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [activityAvailabilityChanging, hasActivity]);
    useEffect(() => {
        if (modelsOpen)
            preloadModelsPicker();
    }, [modelsOpen]);
    const surfaceHidden = hidden || !hasActivity;
    const resolvedPortalTarget = portalTarget ?? document.querySelector(".full-body") ?? document.body;
    return createPortal(<aside className="workspace-home-surface" data-hidden={surfaceHidden ? "true" : "false"} data-activity-availability-changing={activityAvailabilityChanging ? "true" : undefined} aria-label="Activity" aria-hidden={surfaceHidden} inert={surfaceHidden}>
      <div className="workspace-home-surface__inner">
        <div className="workspace-home-surface__body" data-models-open={modelsOpen || undefined}>
          <div className="workspace-home-surface__activity">
            <HomeSection />
          </div>
          {modelsOpen ? (<div className="workspace-home-surface__models">
              <Suspense fallback={<div className="workspace-home-surface__models-loading" aria-busy="true" aria-live="polite">
                  Loading…
                </div>}>
                <AgentModelPicker active={!surfaceHidden} mode={modelsMode}/>
              </Suspense>
            </div>) : null}
        </div>
        <div className="workspace-home-surface__footer">
          <SidebarModelsControl />
        </div>
      </div>
    </aside>, resolvedPortalTarget);
}
