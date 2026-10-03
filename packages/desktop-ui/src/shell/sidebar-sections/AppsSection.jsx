/**
 * Apps — the cloud app library, and the apps themselves.
 *
 * Sub-location (`sidebarSections` → `locations.apps`) is a cloud-app location
 * (`cloud:<appId>`), or `null` for the library list.
 *
 * `<PersistentCloudAppsHost />` renders here as a sibling of the library, not
 * inside the branch that shows the open app, and it is never conditioned on
 * which app is open. App surfaces have to be mounted in their final home and
 * only ever hidden: portalling or re-parenting a live subtree preserves React
 * state but destroys iframe browsing contexts and resets `<video>`/`<canvas>`
 * and scroll position. Everything about where the host sits in this tree
 * exists to keep its DOM nodes still.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { CloudAppsLibrary } from "@/features/cloud/CloudAppsLibrary";
import { PersistentCloudAppsHost } from "@/features/cloud/PersistentCloudAppsHost";
import { isCloudAppLocation } from "@/features/cloud/open-cloud-app-panel";
import { useCloudApps } from "@/features/cloud/use-cloud-apps";
import { useSidebarSectionLocation } from "@/features/workspace-display/sidebar-sections";
import { useT } from "@/shared/i18n";
import { dispatchComposeText } from "@/shared/lib/stella-orb-chat";
import { AppWindowMac } from "@/ui/icons";
import "./apps-section.css";
export function AppsSection() {
  const cloudApps = useCloudApps();
  const openCloudApp = isCloudAppLocation(useSidebarSectionLocation("apps"));
  return (
    <>
      {/* Back-to-library nav lives in the top bar now (browser-tab model),
          so there is no in-body section header here. */}
      <div className="apps-section__body">
        {openCloudApp ? null : (
          <div className="apps-section__library">
            <CloudAppsLibrary state={cloudApps} />
            {cloudApps.phase === "ready" && cloudApps.apps.length === 0 ? (
              <AppsEmpty />
            ) : null}
          </div>
        )}
        <PersistentCloudAppsHost state={cloudApps} />
      </div>
    </>
  );
}
/**
 * Hands the user to chat with the "what can you build me" prompt already in
 * the composer. The compose event only lands on a mounted composer, so the
 * navigation has to settle first.
 */
function AppsEmpty() {
  const navigate = useNavigate();
  const t = useT();
  const requestApp = useCallback(() => {
    void navigate({ to: "/chat" }).then(() => {
      requestAnimationFrame(() => {
        dispatchComposeText({ text: t("app.apps.createAppPrompt") });
      });
    });
  }, [navigate, t]);
  return (
    <div className="sidebar-section__empty">
      <span className="sidebar-section__empty-icon" aria-hidden="true">
        <AppWindowMac size={17} strokeWidth={1.75} />
      </span>
      <p className="sidebar-section__empty-title">No apps yet</p>
      <p className="sidebar-section__empty-body">
        Ask Stella to build a small app. It will show up here.
      </p>
      <button type="button" className="pill-btn" onClick={requestApp}>
        Ask Stella to create an app
      </button>
    </div>
  );
}
