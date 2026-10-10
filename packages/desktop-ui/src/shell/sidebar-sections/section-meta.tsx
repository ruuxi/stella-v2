/**
 * Presentation metadata (label + icon) for each right-sidebar destination.
 *
 * Shared by the top bar's current-view indicator and the Home launcher's
 * option list so both stay in sync. `home` is the launcher itself and never
 * appears as one of the launcher's own options.
 */
import { AppWindowMac, Download, Folder, Globe, House, Lock } from "@/ui/icons";
import type { IconComponent } from "@/ui/icons";
import type { SidebarSection } from "@/features/workspace-display/sidebar-sections";

export type SidebarSectionMeta = {
  label: string;
  Icon: IconComponent;
};

export const SIDEBAR_SECTION_META: Record<SidebarSection, SidebarSectionMeta> =
  {
    home: { label: "Home", Icon: House },
    files: { label: "Files", Icon: Folder },
    apps: { label: "Apps", Icon: AppWindowMac },
    browser: { label: "Browser", Icon: Globe },
    updates: { label: "Updates", Icon: Download },
    takeover: { label: "Sign in", Icon: Lock },
  };

/**
 * The destinations offered by the Home launcher, in display order. Updates
 * is offered only while Stella runs from its own source, the one case where
 * it has anything to list.
 */
export const HOME_LAUNCHER_SECTIONS: ReadonlyArray<
  Exclude<SidebarSection, "home" | "takeover">
> = ["files", "apps", "browser", "updates"];
