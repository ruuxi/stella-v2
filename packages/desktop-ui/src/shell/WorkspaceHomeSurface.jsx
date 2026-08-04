import { createPortal } from "react-dom";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { HomeSection } from "@/shell/sidebar-sections/HomeSection";
import "./workspace-home-surface.css";
/**
 * The always-available Activity surface beside the main app.
 *
 * This is deliberately a sibling of RightSidebar, not one of its sections.
 * Opening the sidebar collapses this surface and replaces it with the panel;
 * closing the sidebar reveals Activity again.
 */
export function WorkspaceHomeSurface({ hidden, portalTarget, }) {
    const chat = useChatRuntime();
    const hasActivity = chat.conversation.tasks.length > 0;
    const surfaceHidden = hidden || !hasActivity;
    const resolvedPortalTarget = portalTarget ?? document.querySelector(".full-body") ?? document.body;
    return createPortal(<aside className="workspace-home-surface" data-hidden={surfaceHidden ? "true" : "false"} aria-label="Activity" aria-hidden={surfaceHidden} inert={surfaceHidden}>
      <div className="workspace-home-surface__inner">
        <div className="workspace-home-surface__body">
          <HomeSection />
        </div>
      </div>
    </aside>, resolvedPortalTarget);
}
