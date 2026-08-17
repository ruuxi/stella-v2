/**
 * Presentation metadata (label + icon) for each right-sidebar destination.
 *
 * Shared by the top bar's current-view indicator and the Home launcher's
 * option list so both stay in sync. `home` is the launcher itself and never
 * appears as one of the launcher's own options.
 */
import { AppWindowMac, Folder, Globe, House, MessageSquare } from "@/ui/icons";
import type { IconComponent } from "@/ui/icons";
import type { SidebarSection } from "@/features/workspace-display/sidebar-sections";

export type SidebarSectionMeta = {
  label: string;
  Icon: IconComponent;
};

export const SIDEBAR_SECTION_META: Record<SidebarSection, SidebarSectionMeta> =
  {
    home: { label: "Home", Icon: House },
    quickchat: { label: "Quick chat", Icon: MessageSquare },
    files: { label: "Files", Icon: Folder },
    apps: { label: "Apps", Icon: AppWindowMac },
    browser: { label: "Browser", Icon: Globe },
  };

/** The destinations offered by the Home launcher, in display order. */
export const HOME_LAUNCHER_SECTIONS: ReadonlyArray<
  Exclude<SidebarSection, "home">
> = ["quickchat", "files", "apps", "browser"];
