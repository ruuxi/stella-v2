import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { openStoreDisplayTab, openTrashDisplayTab } from "./default-tabs";
import "./chat-home-overview.css";
const ENTRIES = [
    {
        id: "files",
        label: "Files",
        description: "Pages, images, video, and documents",
        kind: "media",
        // A launcher entry is a jump to the top of a surface, so this lands on
        // the list rather than on whichever file the section was last showing.
        onSelect: () => sidebarSections.openLocation("files", null),
    },
    {
        id: "store",
        label: "Store",
        description: "Add-ons and things you've built",
        kind: "store",
        onSelect: openStoreDisplayTab,
    },
    {
        id: "trash",
        label: "Trash",
        description: "Things you've recently deleted",
        kind: "trash",
        onSelect: openTrashDisplayTab,
    },
];
function LauncherButton({ entry }) {
    return (<button type="button" className="chat-home-launcher__entry" onClick={entry.onSelect}>
      <span className="chat-home-launcher__entry-icon" aria-hidden="true">
        <DisplayTabIcon kind={entry.kind} size={20}/>
      </span>
      <span className="chat-home-launcher__entry-text">
        <span className="chat-home-launcher__entry-label">{entry.label}</span>
        <span className="chat-home-launcher__entry-description">
          {entry.description}
        </span>
      </span>
    </button>);
}
export function HomeLauncherTab() {
    return (<div className="chat-home-launcher">
      <ul className="chat-home-launcher__list">
        {ENTRIES.map((entry) => (<li key={entry.id}>
            <LauncherButton entry={entry}/>
          </li>))}
      </ul>
    </div>);
}
