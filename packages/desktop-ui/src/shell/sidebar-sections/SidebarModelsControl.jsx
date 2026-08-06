import {
  engineOverlay,
  useEngineOverlayMode,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { AudioLines, Image, MessageSquare, SlidersHorizontal } from "@/ui/icons";
import "./sidebar-models-control.css";

/** Shared entry point for the inline lower-half model panels. */
export function SidebarModelsControl() {
  const modelsPickerOpen = useEngineOverlayOpen();
  const mode = useEngineOverlayMode();

  const modeButton = (value, label, Icon) => (
    <button
      key={value}
      type="button"
      role="tab"
      className="work-model-mode-button"
      data-active={mode === value || undefined}
      aria-selected={mode === value}
      aria-label={label}
      title={label}
      onClick={() => engineOverlay.setMode(value)}
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );

  return (
    <div className="work-models-controls">
      {modelsPickerOpen ? (
        <div className="work-model-mode-controls" role="tablist" aria-label="Model type">
          {modeButton("assistant", "Assistant", MessageSquare)}
          {modeButton("image", "Image", Image)}
          {modeButton("voice", "Voice", AudioLines)}
        </div>
      ) : null}
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
    </div>
  );
}
