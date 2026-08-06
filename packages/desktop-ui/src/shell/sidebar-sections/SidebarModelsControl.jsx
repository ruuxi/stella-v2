import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";
import { SlidersHorizontal } from "@/ui/icons";

/** Opens Models in Work, or toggles it when already inside Work. */
export function SidebarModelsControl({ openSidebar = false } = {}) {
  const modelsPickerOpen = useEngineOverlayOpen();

  const handleClick = () => {
    if (openSidebar) {
      sidebarSections.setActiveSection("files");
      displayTabs.setPanelOpen(true);
      engineOverlay.setOpen(true);
      return;
    }

    engineOverlay.toggle();
  };

  return (
    <button
      type="button"
      className="pill-btn work-models-button"
      data-active={modelsPickerOpen || undefined}
      aria-pressed={modelsPickerOpen}
      onClick={handleClick}
    >
      <SlidersHorizontal size={14} strokeWidth={1.75} />
      Models
    </button>
  );
}
