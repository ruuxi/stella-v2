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

export const HOME_LAUNCHER_SECTIONS: ReadonlyArray<
  Exclude<SidebarSection, "home">
> = ["quickchat", "files", "apps", "browser"];
