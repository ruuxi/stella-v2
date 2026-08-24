import type { SidebarSection } from "@/features/workspace-display/sidebar-sections";

type GlobalModelsControlVisibility = {
  panelOpen: boolean;
  activeSidebarSection: SidebarSection;
};

export const shouldShowGlobalModelsControl = ({
  panelOpen,
  activeSidebarSection,
}: GlobalModelsControlVisibility): boolean =>
  panelOpen && activeSidebarSection !== "quickchat";
