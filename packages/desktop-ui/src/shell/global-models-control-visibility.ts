import type { SidebarSection } from "@/features/workspace-display/sidebar-sections";

/**
 * The global Models control follows the display panel: it is only useful while
 * a right-side surface is on screen, and Quick chat is excluded because it is
 * its own ephemeral thread rather than the main conversation. The control never
 * contributes to this state — it only reads it — so it can never force the
 * right region into existence.
 */
type GlobalModelsControlVisibility = {
  panelOpen: boolean;
  activeSidebarSection: SidebarSection;
};

export const shouldShowGlobalModelsControl = ({
  panelOpen,
  activeSidebarSection,
}: GlobalModelsControlVisibility): boolean =>
  panelOpen && activeSidebarSection !== "quickchat";
