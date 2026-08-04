import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { openCanvasDisplayTab, openMediaDisplayTab, openTrashDisplayTab, } from "./default-tabs";
import "./chat-home-overview.css";
const ENTRIES = [
    {
        id: "canvas",
        label: "Canvas",
        description: "Pages Stella has put together",
        kind: "canvas",
        onSelect: openCanvasDisplayTab,
    },
    {
        id: "media",
        label: "Media",
        description: "Generated images, video, and audio",
        kind: "media",
        onSelect: openMediaDisplayTab,
    },
    {
        id: "trash",
        label: "Trash",
        description: "Things you've recently deleted",
        kind: "trash",
        onSelect: openTrashDisplayTab,
    },
];
function OverviewButton({ entry }) {
    return (<button type="button" className="chat-home-overview__entry" onClick={entry.onSelect}>
      <span className="chat-home-overview__entry-icon" aria-hidden="true">
        <DisplayTabIcon kind={entry.kind} size={20}/>
      </span>
      <span className="chat-home-overview__entry-text">
        <span className="chat-home-overview__entry-label">{entry.label}</span>
        <span className="chat-home-overview__entry-description">
          {entry.description}
        </span>
      </span>
    </button>);
}
export function HomeOverviewTab() {
    return (<div className="chat-home-overview">
      <ul className="chat-home-overview__list">
        {ENTRIES.map((entry) => (<li key={entry.id}>
            <OverviewButton entry={entry}/>
          </li>))}
      </ul>
    </div>);
}
