/**
 * Media viewer for one generated asset: the model chip, prompt and
 * action bar over a full-bleed preview. Which asset is showing is the Files
 * section's business, so this takes the item it should render.
 *
 * Swiping (a horizontal trackpad swipe, a drag across an image at fit size,
 * or the arrow keys) steps through the other media files in the Files list,
 * in the list's order, within this same sidebar tab.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import type { SwipeDirection } from "@/shell/ZoomableImage";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";
import {
  useFileEntries,
  type FileEntry,
} from "@/features/workspace-display/files-index";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { removeGeneratedMediaItem } from "../payload-to-tab-spec";
import type { MediaTabItem } from "./media-item";
import { MediaActionBar } from "./MediaActionBar";
import { HeroPrompt } from "./HeroPrompt";
import { useT } from "@/shared/i18n";
import "../media-tab.css";

/** Accumulated horizontal wheel travel that counts as one swipe. */
const WHEEL_SWIPE_PX = 80;
/** Quiet time that ends one trackpad gesture (and its inertia). */
const WHEEL_GESTURE_IDLE_MS = 220;

/**
 * The trackpad gesture in progress. A swipe swaps this viewer for the next
 * file's, and that swipe's inertia keeps arriving at the new one, so the lock
 * lives outside any one viewer: one gesture steps one file.
 */
const wheelGesture: {
  travel: number;
  fired: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
} = { travel: 0, fired: false, idleTimer: null };

const isSwipeableMedia = (entry: FileEntry): boolean =>
  entry.source === "media" &&
  entry.payload.kind === "media" &&
  (entry.payload.asset.kind === "image" ||
    entry.payload.asset.kind === "video" ||
    entry.payload.asset.kind === "audio");

/** The neighbouring media entries of `itemId` in the Files list. */
const useMediaNeighbours = (itemId: string) => {
  const entries = useFileEntries();
  return useMemo(() => {
    const media = entries.filter(isSwipeableMedia);
    const index = media.findIndex((entry) => entry.id === itemId);
    if (index === -1) return { previous: null, next: null };
    return {
      previous: media[index - 1] ?? null,
      next: media[index + 1] ?? null,
    };
  }, [entries, itemId]);
};

/**
 * Show `entry` in place of the current file: registers its viewer without
 * activating anything, then repoints the active Files tab at it, so stepping
 * through files never stacks a new sidebar tab per file.
 */
const showInPlace = (entry: FileEntry) => {
  openDisplayPayloadTab(entry.payload, { activate: false });
  sidebarSections.setLocation("files", entry.id);
};

export const MediaTabContent = ({ item }: { item: MediaTabItem }) => {
  const t = useT();
  const neighbours = useMediaNeighbours(item.id);
  const neighboursRef = useRef(neighbours);
  neighboursRef.current = neighbours;
  const previewRef = useRef<HTMLDivElement | null>(null);

  const step = useCallback((direction: SwipeDirection) => {
    const target =
      direction === "next"
        ? neighboursRef.current.next
        : neighboursRef.current.previous;
    if (target) showInPlace(target);
  }, []);

  // Two-finger horizontal trackpad swipes arrive as wheel events. A zoomed
  // image claims the wheel for panning before it reaches this listener.
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const gesture = wheelGesture;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (gesture.idleTimer) clearTimeout(gesture.idleTimer);
      gesture.idleTimer = setTimeout(() => {
        gesture.idleTimer = null;
        gesture.travel = 0;
        gesture.fired = false;
      }, WHEEL_GESTURE_IDLE_MS);
      if (gesture.fired || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
        return;
      }
      gesture.travel += event.deltaX;
      if (Math.abs(gesture.travel) < WHEEL_SWIPE_PX) return;
      gesture.fired = true;
      step(gesture.travel > 0 ? "next" : "previous");
    };
    preview.addEventListener("wheel", onWheel, { passive: true });
    // The idle timer outlives this viewer: it is what releases the lock once
    // the gesture that replaced this viewer goes quiet.
    return () => preview.removeEventListener("wheel", onWheel);
  }, [step]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      // Media controls (a video's scrubber) keep their own arrow keys.
      const target = event.target as HTMLElement;
      if (target.closest("video, audio, input, [role='slider']")) return;
      if (event.key === "ArrowRight") step("next");
      else if (event.key === "ArrowLeft") step("previous");
      else return;
      event.preventDefault();
    },
    [step],
  );

  const handleDelete = useCallback(() => {
    removeGeneratedMediaItem(item.id);
    // Deleting the asset leaves the viewer with nothing to show, so retire
    // the tab and drop back to the Files list.
    displayTabs.closeTab(item.id);
    sidebarSections.clearLocation("files");
  }, [item.id]);

  return (
    <div className="media-tab">
      <div className="media-tab__surface">
        <div className="media-tab__hero">
          <div
            className="media-tab__hero-bar"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="media-tab__hero-bar-top">
              {item.madeBy ? (
                <span className="media-tab__hero-cap">
                  {item.madeBy}
                </span>
              ) : null}
              <div
                className="media-tab__hero-actions"
                role="group"
                aria-label={t("shell.display.media.itemActions")}
              >
                <MediaActionBar item={item} onDelete={handleDelete} />
              </div>
            </div>
            {item.prompt ? <HeroPrompt text={item.prompt} /> : null}
          </div>
          <div
            ref={previewRef}
            className="media-tab__hero-preview"
            onKeyDown={handleKeyDown}
          >
            <MediaPreviewCard
              asset={item.asset}
              inDialog
              onSwipe={step}
              {...(item.prompt ? { prompt: item.prompt } : {})}
              {...(item.madeBy ? { madeBy: item.madeBy } : {})}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
