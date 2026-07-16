/**
 * Display-tab body shown for the Home tab while the user is on the home
 * (`/chat`) route.
 *
 * Home itself IS the chat, so this surface never hosts a duplicate
 * conversation. Instead it offers the other display surfaces the user might
 * want (Canvas, Media, Trash). Activity, files, and schedules already live in
 * the left sidebar, and Models lives in the sidebar footer.
 */
import type { ReactNode } from "react";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import type { DisplayTabKind } from "@/features/workspace-display/types";
import {
  openCanvasDisplayTab,
  openMediaDisplayTab,
  openTrashDisplayTab,
} from "./default-tabs";
import "./chat-home-overview.css";

type OverviewEntry = {
  id: string;
  label: string;
  description: string;
  kind: DisplayTabKind;
  onSelect: () => void;
};

const ENTRIES: ReadonlyArray<OverviewEntry> = [
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

function OverviewButton({ entry }: { entry: OverviewEntry }): ReactNode {
  return (
    <button
      type="button"
      className="chat-home-overview__entry"
      onClick={entry.onSelect}
    >
      <span className="chat-home-overview__entry-icon" aria-hidden="true">
        <DisplayTabIcon kind={entry.kind} size={20} />
      </span>
      <span className="chat-home-overview__entry-text">
        <span className="chat-home-overview__entry-label">{entry.label}</span>
        <span className="chat-home-overview__entry-description">
          {entry.description}
        </span>
      </span>
    </button>
  );
}

export function HomeOverviewTab() {
  return (
    <div className="chat-home-overview">
      <ul className="chat-home-overview__list">
        {ENTRIES.map((entry) => (
          <li key={entry.id}>
            <OverviewButton entry={entry} />
          </li>
        ))}
      </ul>
    </div>
  );
}
