import { useCallback } from "react";
import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";
import { removeGeneratedMediaItem } from "../payload-to-tab-spec";
import type { MediaTabItem } from "./media-item";
import { MediaActionBar } from "./MediaActionBar";
import { HeroPrompt } from "./HeroPrompt";
import { useT } from "@/shared/i18n";
import "../media-tab.css";

export const MediaTabContent = ({ item }: { item: MediaTabItem }) => {
  const t = useT();
  const handleDelete = useCallback(() => {
    removeGeneratedMediaItem(item.id);

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
              {item.capability ? (
                <span className="media-tab__hero-cap">
                  {item.capability.replace(/_/g, " ")}
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
          <div className="media-tab__hero-preview">
            <MediaPreviewCard
              asset={item.asset}
              inDialog
              {...(item.prompt ? { prompt: item.prompt } : {})}
              {...(item.capability ? { capability: item.capability } : {})}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
