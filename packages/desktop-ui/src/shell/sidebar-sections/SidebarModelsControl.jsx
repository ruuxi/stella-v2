import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { SlidersHorizontal } from "@/ui/icons";
import "./sidebar-models-control.css";

/** Shared entry point for the inline lower-half model panels. */
export function SidebarModelsControl() {
  const modelsPickerOpen = useEngineOverlayOpen();

  return (
    <button
      type="button"
      className="pill-btn work-models-button"
      data-active={modelsPickerOpen || undefined}
      aria-pressed={modelsPickerOpen}
      onClick={engineOverlay.toggle}
    >
      <SlidersHorizontal size={14} strokeWidth={1.75} />
      Models
    </button>
  );
}
