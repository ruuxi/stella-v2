import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { SlidersHorizontal } from "@/ui/icons";

/** Work-only control that swaps the Work body with the inline model panel. */
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
