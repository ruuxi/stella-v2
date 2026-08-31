/**
 * Global Models control — the bottom-right model-picker button + popover.
 *
 * Mounted ONCE at the shell level (see `routes/__root.tsx`), NOT inside the
 * right sidebar, so it is always visible and openable regardless of which
 * sidebar tab is active or whether the sidebar is open, closed or mounted.
 *
 * Open state lives in the shared engine-overlay singleton store, which
 * `openModelPicker()` and the `stella:open-model-picker` window event also flip.
 * The picker itself renders as a top-level portal popover (radix `Popover`)
 * above the whole app, so its lifecycle/anchor are not owned by the sidebar.
 */
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
import { GlobalExecutionTargetControl } from "./GlobalExecutionTargetControl";
import "./global-models-control.css";

const AgentModelPicker = lazy(() =>
  import("@/global/settings/AgentModelPicker").then((module) => ({
    default: module.AgentModelPicker,
  })),
);

/**
 * @param {{ visible?: boolean }} props `visible` follows the shell's
 *   authoritative right-side Activity-workspace visibility. When the right
 *   region isn't displaying, the control renders nothing so it never leaves an
 *   empty right gutter behind. State/overlay/lifecycle stay globally owned
 *   (engine-overlay store) — this only gates whether the button is on screen.
 */
export function GlobalModelsControl({ visible = true }) {
  const open = useEngineOverlayOpen();
  const modelPinned = useComposerModelPinned();

  useEffect(() => {
    if (visible && open) preloadModelsPicker();
  }, [open, visible]);

  if (!visible) return null;

  return (
    <div className="global-models-control">
      <GlobalExecutionTargetControl />
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
