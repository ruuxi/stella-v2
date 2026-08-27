import { AppWindowMac, LoaderCircle } from "@/ui/icons";
import { openCloudAppPanel } from "./open-cloud-app-panel";
import { useCloudApps } from "./use-cloud-apps";

export function CloudAppsLibrary() {
  const state = useCloudApps();

  if (state.phase === "disabled") return null;
  if (state.phase === "loading") {
    return (
      <div className="cloud-apps-library__status" role="status">
        <LoaderCircle
          className="stella-loader-circle"
          size={15}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span>Loading cloud apps…</span>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="cloud-apps-library__status" role="alert">
        {state.error}
      </div>
    );
  }
  if (state.apps.length === 0) return null;

  return (
    <section className="cloud-apps-library" aria-labelledby="cloud-apps-title">
      <div className="cloud-apps-library__heading">
        <span id="cloud-apps-title">Cloud apps</span>
        <span>{state.apps.length}</span>
      </div>
      <ul className="apps-section__grid cloud-apps-library__grid">
        {state.apps.map((app) => (
          <li key={app.appId} className="apps-section__card">
            <button
              type="button"
              className="apps-section__card-open"
              onClick={() => openCloudAppPanel(app)}
            >
              <AppWindowMac
                className="apps-section__card-icon"
                size={16}
                strokeWidth={1.7}
                aria-hidden="true"
              />
              <span className="apps-section__card-label">{app.title}</span>
              <span className="cloud-apps-library__badge">Cloud</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
