import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cloudApi } from "@/features/cloud/cloud-api";
import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { cloudAppUrl, CLOUD_APPS_HOST } from "@/features/cloud/cloud-config";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { RefreshCw, RotateCcw, Trash2 } from "@/ui/icons";
import "./cloud-app-page.css";

type BridgeRequest = {
  source?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
};

const convexSiteUrl = () => {
  const value = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!value) throw new Error("Stella cloud services are not configured.");
  return value.replace(/\/+$/, "");
};

export const Route = createFileRoute("/apps/$slug")({
  component: CloudAppPage,
});

function CloudAppPage() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useConvexAuth();
  const apps = useQuery(cloudApi.listMyApps, isAuthenticated ? {} : "skip");
  const app = apps?.find((candidate) => candidate.slug === slug);
  const builds = useQuery(
    cloudApi.listMyAppBuilds,
    app ? { appId: app.appId } : "skip",
  );
  const applyBuild = useAction(cloudApi.applyMyBuild);
  const deleteApp = useAction(cloudApi.deleteMyApp);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<{
    token: string;
    user: unknown;
    expiresAt: number;
  } | null>(null);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const appUrl = useMemo(() => (app ? cloudAppUrl(app.slug) : null), [app]);
  const frameUrl = useMemo(
    () =>
      appUrl && import.meta.env.DEV
        ? `${appUrl}?stella-platform-check=1`
        : appUrl,
    [appUrl],
  );

  useEffect(() => {
    if (!app) return;
    const key = `stella:app-permissions:${app.appId}`;
    if (!window.localStorage.getItem(key)) {
      window.localStorage.setItem(key, JSON.stringify(["identity", "storage"]));
      setNoticeVisible(true);
    }
  }, [app]);

  const getSession = useCallback(async () => {
    if (
      sessionRef.current &&
      sessionRef.current.expiresAt > Date.now() + 5_000
    ) {
      return sessionRef.current;
    }
    if (!app) throw new Error("App not found.");
    const headers = await getAuthHeaders({
      "content-type": "application/json",
    });
    const response = await fetch(`${convexSiteUrl()}/api/apps/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ appId: app.appId }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(payload.error ?? "Could not open the app.");
    sessionRef.current = payload;
    return payload;
  }, [app]);

  useEffect(() => {
    if (!appUrl) return;
    const appOrigin = new URL(appUrl).origin;
    const onMessage = (event: MessageEvent<BridgeRequest>) => {
      const message = event.data;
      if (
        event.origin !== appOrigin ||
        event.source !== iframeRef.current?.contentWindow ||
        message?.source !== "stella-app" ||
        !message.id ||
        !message.method
      ) {
        return;
      }
      const method = message.method;
      const respond = (result?: unknown, error?: string) => {
        iframeRef.current?.contentWindow?.postMessage(
          { id: message.id, result, error },
          appOrigin,
        );
      };
      void (async () => {
        try {
          if (method === "session") {
            respond(await getSession());
            return;
          }
          if (method.startsWith("storage/")) {
            const session = await getSession();
            const response = await fetch(
              `${convexSiteUrl()}/api/apps/${method}`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${session.token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(message.params ?? {}),
              },
            );
            const payload = await response.json();
            if (!response.ok)
              throw new Error(payload.error ?? "App storage failed.");
            respond(payload);
            return;
          }
          if (method === "share") {
            const shareData = message.params as ShareData;
            if (navigator.share) await navigator.share(shareData);
            else
              await navigator.clipboard.writeText(
                shareData.url ?? shareData.text ?? "",
              );
            respond({ ok: true });
            return;
          }
          if (method === "fetch") {
            const params = message.params as {
              input?: string;
              init?: { method?: string; headers?: HeadersInit; body?: string };
            };
            const response = await fetch(`${CLOUD_APPS_HOST}/api/apps/fetch`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(params),
            });
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            respond({
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: btoa(binary),
              base64: true,
            });
            return;
          }
          throw new Error("This app capability is not available.");
        } catch (error) {
          respond(
            undefined,
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appUrl, getSession]);

  if (!apps) {
    return (
      <main className="cloud-app-page cloud-app-page--state">Loading app…</main>
    );
  }
  if (!app || !appUrl) {
    return (
      <main className="cloud-app-page cloud-app-page--state">
        <h1>App not found</h1>
        <Link to="/chat">Back to chat</Link>
      </main>
    );
  }

  const previousBuild = builds?.find(
    (build) => build.buildId !== app.activeBuildId && build.artifactPrefix,
  );

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setActionError(null);
    setBusyAction(name);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <main className="cloud-app-page">
      <header className="cloud-app-page__header">
        <div className="cloud-app-page__identity">
          <span className="cloud-app-page__icon" aria-hidden="true">
            {app.title.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h1>{app.title}</h1>
            <p>Built with Stella · Private</p>
          </div>
        </div>
        <div className="cloud-app-page__actions">
          <Link to="/chat">
            <RefreshCw size={15} strokeWidth={1.8} aria-hidden="true" />
            Iterate
          </Link>
          <button
            type="button"
            disabled={!previousBuild || busyAction !== null}
            onClick={() => {
              if (!previousBuild) return;
              void runAction("rollback", () =>
                applyBuild({ buildId: previousBuild.buildId }),
              );
            }}
          >
            <RotateCcw size={15} strokeWidth={1.8} aria-hidden="true" />
            {busyAction === "rollback" ? "Rolling back…" : "Rollback"}
          </button>
          <button
            type="button"
            className="cloud-app-page__delete"
            disabled={busyAction !== null}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove ${app.title}? Its builds will remain recoverable.`,
                )
              ) {
                return;
              }
              void runAction("delete", async () => {
                await deleteApp({ appId: app.appId });
                await navigate({ to: "/chat" });
              });
            }}
          >
            <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
            Remove
          </button>
        </div>
      </header>
      {noticeVisible ? (
        <div className="cloud-app-page__notice" role="status">
          <span>
            This app can use your Stella identity and private app storage.
          </span>
          <button type="button" onClick={() => setNoticeVisible(false)}>
            Got it
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="cloud-app-page__error" role="alert">
          {actionError} Try again.
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        className="cloud-app-page__frame"
        src={frameUrl ?? undefined}
        title={app.title}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        allow="clipboard-write"
      />
    </main>
  );
}
