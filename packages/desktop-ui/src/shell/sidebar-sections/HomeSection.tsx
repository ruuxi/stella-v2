/**
 * Standalone Activity — the agent index.
 *
 * It used to be rendered by a permanent right-hand surface beside the chat.
 * That surface is gone; the list now opens from the top bar's activity
 * indicator, which is its only host. Search and agent-thread viewers still
 * live in the right sidebar's Work section.
 */

import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import "./home-search.css";

export function ActivityOverview({
  onNavigate,
}: {
  onNavigate?: () => void;
} = {}) {
  return (
    <div className="sidebar-search">
      <div className="sidebar-search__body">
        <WorkspaceSections
          variant="overview"
          searchMode="quick"
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}
