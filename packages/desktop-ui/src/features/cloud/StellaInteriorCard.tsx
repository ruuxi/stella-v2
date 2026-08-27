import { useCallback, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { CloudBoundary } from "./CloudBoundary";
import { cloudApi } from "./cloud-api";
import { CLOUD_APPS_HOST } from "./cloud-config";

const compactRevision = (value: string | null): string =>
  value?.replace(/^sha256:/, "").slice(0, 10) ?? "unknown";

const buildLabel = (createdAt: number): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAt));

function StellaInteriorCardImpl() {
  const deployment = useQuery(cloudApi.listMyInteriorBuilds, { limit: 8 });
  const promote = useMutation(cloudApi.promoteMyInteriorBuild);
  const rollback = useMutation(cloudApi.rollbackMyInteriorBuild);
  const [busyBuildId, setBusyBuildId] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const handlePromote = useCallback(
    async (buildId: string) => {
      if (!deployment) return;
      setBusyBuildId(buildId);
      try {
        await promote({
          buildId,
          expectedRouteRevision: deployment.routeRevision,
        });
        showToast({
          title: "Stella interior selected. Applying on this device…",
          variant: "success",
        });
      } catch (error) {
        showToast({
          title:
            error instanceof Error
              ? error.message
              : "The Stella interior could not be activated.",
          variant: "error",
        });
      } finally {
        setBusyBuildId(null);
      }
    },
    [deployment, promote],
  );

  const handleRollback = useCallback(async () => {
    if (!deployment?.activeBuildId) return;
    setRollingBack(true);
    try {
      await rollback({ expectedRouteRevision: deployment.routeRevision });
      showToast({
        title: deployment.previousBuildId
          ? "Rollback selected. Applying on this device…"
          : "Packaged renderer selected. Applying on this device…",
        variant: "success",
      });
    } catch (error) {
      showToast({
        title:
          error instanceof Error
            ? error.message
            : "The Stella interior could not be rolled back.",
        variant: "error",
      });
    } finally {
      setRollingBack(false);
    }
  }, [deployment, rollback]);

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Stella interior</h3>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Deployed web renderer</div>
          <div className="settings-row-sublabel">
            Agents working in <code>workspace: "stella"</code> publish immutable
            candidates here. Selecting one asks each packaged shell to download,
            verify, and health-check it; the previous version stays available
            for rollback.
          </div>
        </div>
        {deployment ? (
          <div className="settings-row-control flex gap-2">
            {deployment.stableRouteId ? (
              CLOUD_APPS_HOST ? (
                <a
                  className="pill-btn"
                  href={`${CLOUD_APPS_HOST}/stella/${encodeURIComponent(deployment.stableRouteId)}/`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open web
                </a>
              ) : null
            ) : null}
            {deployment.activeBuildId ? (
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                onClick={() => void handleRollback()}
                disabled={rollingBack || busyBuildId !== null}
              >
                {rollingBack
                  ? "Rolling back…"
                  : deployment.previousBuildId
                    ? "Rollback"
                    : "Use packaged"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {!CLOUD_APPS_HOST ? (
        <div className="settings-row" role="status">
          <div className="settings-row-sublabel">
            Web preview unavailable: this build is missing its cloud Apps host
            configuration.
          </div>
        </div>
      ) : null}
      {!deployment ? (
        <div className="settings-row">
          <div className="settings-row-sublabel">Loading deployments…</div>
        </div>
      ) : deployment.builds.length === 0 ? (
        <div className="settings-row">
          <div className="settings-row-sublabel">
            No candidates yet. Ask Stella to make a change in its{" "}
            <code>stella</code> workspace.
          </div>
        </div>
      ) : (
        deployment.builds.map((build) => (
          <div className="settings-row" key={build.buildId}>
            <div className="settings-row-info">
              <div className="settings-row-label">
                {build.isActive
                  ? "Selected"
                  : build.isPrevious
                    ? "Previous"
                    : "Candidate"}{" "}
                · {buildLabel(build.createdAt)}
              </div>
              <div className="settings-row-sublabel">
                revision {compactRevision(build.sourceRevision)} ·{" "}
                {(build.artifactSizeBytes / 1024 / 1024).toFixed(1)} MB
              </div>
            </div>
            {!build.isActive ? (
              <div className="settings-row-control">
                <Button
                  type="button"
                  variant="ghost"
                  className="pill-btn"
                  onClick={() => void handlePromote(build.buildId)}
                  disabled={busyBuildId !== null || rollingBack}
                >
                  {busyBuildId === build.buildId ? "Selecting…" : "Select"}
                </Button>
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

export function StellaInteriorCard() {
  const { isAuthenticated } = useConvexAuth();
  if (!isAuthenticated) return null;
  return (
    <CloudBoundary>
      <StellaInteriorCardImpl />
    </CloudBoundary>
  );
}
