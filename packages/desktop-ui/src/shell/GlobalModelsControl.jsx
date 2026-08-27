import { lazy, Suspense, useEffect } from "react";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import {
  composerModelPin,
  useComposerModelPinned,
} from "@/features/chat/composer-model-pin-store";
import { preloadModelsPicker } from "@/shell/topbar/nav-surface-preloads";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { Switch } from "@/ui/switch";
import { SlidersHorizontal } from "@/ui/icons";
import "./global-models-control.css";

const AgentModelPicker = lazy(() =>
  import("@/global/settings/AgentModelPicker").then((module) => ({
    default: module.AgentModelPicker,
  })),
);

export function GlobalModelsControl({ visible = true }) {
  const open = useEngineOverlayOpen();
  const modelPinned = useComposerModelPinned();

  useEffect(() => {
    if (visible && open) preloadModelsPicker();
  }, [open, visible]);

  if (!visible) return null;

  return (
    <div className="global-models-control">
      <Popover open={open} onOpenChange={(next) => engineOverlay.setOpen(next)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="pill-btn work-models-button"
            data-active={open || undefined}
            aria-pressed={open}
            onMouseEnter={preloadModelsPicker}
            onFocus={preloadModelsPicker}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
            Models
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="models-popover"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
        >
          <PopoverBody className="models-popover__body">
            <div className="models-popover__panel">
              <Suspense
                fallback={
                  <div
                    className="work-models-panel__loading"
                    aria-busy="true"
                    aria-live="polite"
                  >
                    Loading…
                  </div>
                }
              >
                <AgentModelPicker active={open} />
              </Suspense>
            </div>
            <div className="models-popover__footer">
              <Switch
                className="work-models-pin-switch"
                label="Show in composer"
                checked={modelPinned}
                onCheckedChange={() => composerModelPin.toggle()}
              />
            </div>
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </div>
  );
}
