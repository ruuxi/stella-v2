import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { openCloudAppPanel } from "@/features/cloud/open-cloud-app-panel";
import { useCloudApps } from "@/features/cloud/use-cloud-apps";

export const Route = createFileRoute("/apps/$slug")({
  component: CloudAppDeepLink,
});

/** Compatibility only: the current Apps sidebar remains the real surface. */
function CloudAppDeepLink() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const cloudApps = useCloudApps();
  const app = cloudApps.apps.find((candidate) => candidate.slug === slug);

  useEffect(() => {
    if (cloudApps.phase === "loading") return;
    if (cloudApps.phase === "ready" && app) openCloudAppPanel(app);
    void navigate({ to: "/chat", replace: true });
  }, [app, cloudApps.phase, navigate]);

  return (
    <main className="apps-screen apps-screen--status" role="status">
      {cloudApps.phase === "error"
        ? "Cloud apps are unavailable right now."
        : "Opening app…"}
    </main>
  );
}

