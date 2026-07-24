import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect } from "react";
import { cloudApi } from "@/features/cloud/cloud-api";
import { openCloudAppPanel } from "@/features/cloud/open-cloud-app-panel";

export const Route = createFileRoute("/apps/$slug")({
  component: CloudAppDeepLink,
});

// Compatibility only: app deep links resolve the app, hand it to the
// workspace-panel system, then restore chat as the home route.
function CloudAppDeepLink() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useConvexAuth();
  const apps = useQuery(cloudApi.listMyApps, isAuthenticated ? {} : "skip");
  const app = apps?.find((candidate) => candidate.slug === slug);

  useEffect(() => {
    if (!apps) return;
    if (app) openCloudAppPanel(app, false);
    void navigate({ to: "/chat", replace: true });
  }, [app, apps, navigate]);

  return null;
}
