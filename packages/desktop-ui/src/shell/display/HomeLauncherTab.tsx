/**
 * Display-tab body shown for the Home tab while the user is on the home
 * (`/chat`) route.
 *
 * Home itself IS the chat, so this surface never hosts a duplicate
 * conversation. Instead it's a quiet launcher of the other display surfaces
 * the user might want (Files, Store, Trash) — click one and that surface
 * takes over. Models lives in the sidebar footer rather than here.
 */
import type { ReactNode } from "react";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import type { DisplayTabKind } from "@/features/workspace-display/types";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { useT } from "@/shared/i18n";
import { openStoreDisplayTab, openTrashDisplayTab } from "./default-tabs";
import "./chat-home-overview.css";

type LauncherEntry = {
  id: string;
  labelKey: string;
  descriptionKey: string;
  kind: DisplayTabKind;
  onSelect: () => void;
};

const ENTRIES: ReadonlyArray<LauncherEntry> = [
  {
    id: "files",
    labelKey: "shell.display.homeLauncher.files.label",
    descriptionKey: "shell.display.homeLauncher.files.description",
    kind: "media",
    // A launcher entry is a jump to the top of a surface, so this lands on
    // the list rather than on whichever file the section was last showing.
    onSelect: () => sidebarSections.openLocation("files", null),
  },
  {
    id: "store",
    labelKey: "shell.display.homeLauncher.store.label",
    descriptionKey: "shell.display.homeLauncher.store.description",
    kind: "store",
    onSelect: openStoreDisplayTab,
  },
  {
    id: "trash",
    labelKey: "shell.display.homeLauncher.trash.label",
    descriptionKey: "shell.display.homeLauncher.trash.description",
    kind: "trash",
    onSelect: openTrashDisplayTab,
  },
];

function LauncherButton({ entry }: { entry: LauncherEntry }): ReactNode {
  const t = useT();
  return (
    <button
      type="button"
      className="chat-home-launcher__entry"
      onClick={entry.onSelect}
    >
      <span className="chat-home-launcher__entry-icon" aria-hidden="true">
        <DisplayTabIcon kind={entry.kind} size={20} />
      </span>
      <span className="chat-home-launcher__entry-text">
        <span className="chat-home-launcher__entry-label">
          {t(entry.labelKey)}
        </span>
        <span className="chat-home-launcher__entry-description">
          {t(entry.descriptionKey)}
        </span>
      </span>
    </button>
  );
}

export function HomeLauncherTab() {
  return (
    <div className="chat-home-launcher">
      <ul className="chat-home-launcher__list">
        {ENTRIES.map((entry) => (
          <li key={entry.id}>
            <LauncherButton entry={entry} />
          </li>
        ))}
      </ul>
    </div>
  );
}
