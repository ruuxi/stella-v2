import { useCallback, useEffect, useRef, useState } from "react";
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
  const ensureStableRoute = useMutation(cloudApi.ensureMyInteriorStableRoute);
  const rotateStableRoute = useMutation(cloudApi.rotateMyInteriorStableRoute);
  const promote = useMutation(cloudApi.promoteMyInteriorBuild);
  const rollback = useMutation(cloudApi.rollbackMyInteriorBuild);
  const [busyBuildId, setBusyBuildId] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rotatingRoute, setRotatingRoute] = useState(false);
  const [stableRouteOverride, setStableRouteOverride] = useState<string | null>(
    null,
  );
  const ensuringStableRoute = useRef(false);
  const stableRouteId = stableRouteOverride ?? deployment?.stableRouteId;

  useEffect(() => {
    if (
      stableRouteOverride &&
      deployment?.stableRouteId === stableRouteOverride
    ) {
      setStableRouteOverride(null);
    }
  }, [deployment?.stableRouteId, stableRouteOverride]);

  useEffect(() => {
    if (!deployment || deployment.stableRouteId || ensuringStableRoute.current)
      return;
    ensuringStableRoute.current = true;
    void ensureStableRoute({})
      .then(({ stableRouteId: createdRouteId }) => {
        setStableRouteOverride(createdRouteId);
      })
      .catch((error) => {
        showToast({
          title:
            error instanceof Error
              ? error.message
              : "The Stella web route could not be created.",
          variant: "error",
        });
      })
      .finally(() => {
        ensuringStableRoute.current = false;
      });
  }, [deployment, ensureStableRoute]);

  const handleRotateRoute = useCallback(async () => {
    if (
      !window.confirm(
        "Rotate the Stella web link? The current link will stop working immediately.",
      )
    ) {
      return;
    }
    setRotatingRoute(true);
    try {
      const { stableRouteId: nextRouteId } = await rotateStableRoute({});
      setStableRouteOverride(nextRouteId);
      showToast({
        title: "Stella web link rotated.",
        variant: "success",
      });
    } catch (error) {
      showToast({
        title:
          error instanceof Error
            ? error.message
            : "The Stella web link could not be rotated.",
        variant: "error",
      });
    } finally {
      setRotatingRoute(false);
    }
  }, [rotateStableRoute]);

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
            Agents working in <code>workspace: "stella"</code> publish
            immutable candidates here. Selecting one asks each packaged shell
            to download, verify, and health-check it; the previous version stays
            available for rollback.
          </div>
        </div>
        {deployment ? (
          <div className="settings-row-control flex gap-2">
            {stableRouteId ? (
              <a
                className="pill-btn"
                href={`${CLOUD_APPS_HOST}/stella/${encodeURIComponent(stableRouteId)}/`}
                target="_blank"
                rel="noreferrer"
              >
                Open web
              </a>
            ) : null}
            {stableRouteId ? (
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                onClick={() => void handleRotateRoute()}
                disabled={
                  rotatingRoute || rollingBack || busyBuildId !== null
                }
              >
                {rotatingRoute ? "Rotating…" : "Rotate link"}
              </Button>
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
