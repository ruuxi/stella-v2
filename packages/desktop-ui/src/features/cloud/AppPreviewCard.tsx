import { memo, useEffect, useState } from "react";
import { AppWindowMac, MoreHorizontal } from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { openCloudAppPanel } from "./open-cloud-app-panel";
import { loadCloudAppPreview, useLinkedCloudApp } from "./workspace-app-links";
import "./app-preview-card.css";

/**
 * A cloud app a reply links (`stella://app/<slug>`): a still of the app on
 * top, then its icon, name and "App", with a menu. Clicking opens the app in
 * the side panel. Renders nothing for a slug that is not a ready app.
 */
export const AppPreviewCard = memo(function AppPreviewCard({
  slug,
}: {
  slug: string;
}) {
  const app = useLinkedCloudApp(slug);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!app) return;
    let cancelled = false;
    void loadCloudAppPreview(app).then((url) => {
      if (!cancelled) setPreview(url);
    });
    return () => {
      cancelled = true;
    };
  }, [app?.slug, app?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  if (app === null) return null;
  const open = () => openCloudAppPanel({ appId: slug });
  const icon = app?.icon ? (
    <span className="app-preview-card__emoji" aria-hidden="true">
      {app.icon}
    </span>
  ) : (
    <AppWindowMac size={18} strokeWidth={1.7} aria-hidden="true" />
  );
  return (
    <div className="app-preview-card" data-loading={app ? undefined : ""}>
      <button
        type="button"
        className="app-preview-card__open"
        onClick={open}
        disabled={!app}
        aria-label={app ? `Open ${app.title}` : "Loading app"}
      >
        <span className="app-preview-card__preview">
          <span className="app-preview-card__placeholder">{icon}</span>
          {preview ? <img src={preview} alt="" draggable={false} /> : null}
        </span>
        <span className="app-preview-card__footer">
          <span className="app-preview-card__tile">{icon}</span>
          <span className="app-preview-card__titles">
            <span className="app-preview-card__title">{app?.title ?? ""}</span>
            <span className="app-preview-card__subtitle">App</span>
          </span>
        </span>
      </button>
      {app ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="app-preview-card__more"
              aria-label={`More for ${app.title}`}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6}>
            <DropdownMenuItem onSelect={open}>Open</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
});
