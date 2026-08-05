import { ModelsPicker } from "@/global/settings/ModelsPicker";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { SlidersHorizontal } from "@/ui/icons";
import "./home-search.css";

/** Shared Models affordance for the standalone Activity and panel surfaces. */
export function SidebarModelsControl() {
  const modelsPickerOpen = useEngineOverlayOpen();

  return (
    <ModelsPicker
      open={modelsPickerOpen}
      onOpenChange={engineOverlay.setOpen}
      side="top"
      align="end"
      trigger={
        <button
          type="button"
          className="pill-btn sidebar-home-models-button"
        >
          <SlidersHorizontal size={14} strokeWidth={1.75} />
          Models
        </button>
      }
    />
  );
}
