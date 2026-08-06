import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { SlidersHorizontal } from "@/ui/icons";
import "./sidebar-models-control.css";

/** Shared entry point for Work's inline lower-half model panel. */
export function SidebarModelsControl({ onClick } = {}) {
  const modelsPickerOpen = useEngineOverlayOpen();
  const handleClick = onClick ?? engineOverlay.toggle;

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
