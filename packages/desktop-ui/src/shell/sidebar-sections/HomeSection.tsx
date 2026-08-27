import { useEffect } from "react";
import { openModelPicker } from "@/features/workspace-display/default-tabs";
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

export function HomeSection() {
  useEffect(() => {
    const handleOpenModelPicker = () => openModelPicker();
    window.addEventListener("stella:open-model-picker", handleOpenModelPicker);
    return () => {
      window.removeEventListener(
        "stella:open-model-picker",
        handleOpenModelPicker,
      );
    };
  }, []);
  return <ActivityOverview />;
}
