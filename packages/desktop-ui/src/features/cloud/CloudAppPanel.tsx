import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { cloudApi } from "./cloud-api";
import { cloudAppUrl, CLOUD_APPS_HOST } from "./cloud-config";
import "./cloud-app-panel.css";

type AppSession = {
  token: string;
  expiresAt: number;
  user: {
    userId: string | null;
    username: string;
    anonymous: boolean;
  };
};

type AppBridgeMessage = {
  source?: string;
  protocol?: number;
  nonce?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  kind?: string;
  invocationId?: string;
  ok?: boolean;
  resultJson?: string;
  errorMessage?: string;
};

const FRAME_LOAD_TIMEOUT_MS = 20_000;
const APP_BRIDGE_PROTOCOL = 2;
const STORAGE_BRIDGE_METHODS = new Set([
  "storage/get",
  "storage/list",
  "storage/set",
  "storage/delete",
]);

const convexSiteUrl = (): string => {
  const value = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL,
  );
  if (!value) throw new Error("Stella isn't fully set up yet.");
  return value.replace(/\/+$/, "");
};

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function CloudAppPanel({ slug }: { slug: string }) {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { accountScope } = useCloudMode();
  const apps = useQuery(cloudApi.listMyApps, isAuthenticated ? {} : "skip");
  const app = apps?.find(
    (candidate) =>
      candidate.slug === slug &&
      candidate.status === "active" &&
      typeof candidate.activeBuildId === "string",
  );
  const publishOperations = useMutation(cloudApi.publishMyAppOperations);
  const claimInvocation = useMutation(cloudApi.claimOpInvocation);
  const completeInvocation = useMutation(cloudApi.completeOpInvocation);
  const pendingInvocations = useQuery(
    cloudApi.listPendingOpInvocations,
    isAuthenticated && app ? { appId: app.appId } : "skip",
  );
  const forwardedInvocationsRef = useRef(new Set<string>());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sessionRef = useRef<AppSession | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const frameNonce = useMemo(
    () => crypto.randomUUID(),
    [accountScope, app?.appId, retryKey],
  );
  const [frameState, setFrameState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [frameError, setFrameError] = useState<string | null>(null);
  const appUrl = useMemo(() => (app ? cloudAppUrl(app.slug) : null), [app]);
  const frameUrl = useMemo(() => {
    if (!appUrl) return null;
    if (!import.meta.env.DEV) return appUrl;
    const url = new URL(appUrl);
    url.searchParams.set("stella-platform-check", "1");
    return url.toString();
  }, [appUrl]);

  useEffect(() => {
    sessionRef.current = null;
    forwardedInvocationsRef.current.clear();
    setFrameState("loading");
    setFrameError(null);
  }, [accountScope, app?.appId, retryKey]);

  useEffect(() => {
    if (!frameUrl || frameState !== "loading") return;
    const timeout = window.setTimeout(() => {
      setFrameState("error");
      setFrameError("This app took too long to open.");
    }, FRAME_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [frameState, frameUrl, retryKey]);

  const getSession = useCallback(async (): Promise<AppSession> => {
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
    const payload = (await response.json()) as Partial<AppSession> & {
      error?: string;
    };
    if (
      !response.ok ||
      typeof payload.token !== "string" ||
      typeof payload.expiresAt !== "number" ||
      !payload.user
    ) {
      throw new Error(payload.error ?? "Could not open the app.");
    }
    const session = payload as AppSession;
    sessionRef.current = session;
    return session;
  }, [app]);

  useEffect(() => {
    if (!appUrl) return;
    const appOrigin = new URL(appUrl).origin;
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = event.data as AppBridgeMessage | null;
      if (
        event.origin !== appOrigin ||
        event.source !== iframeRef.current?.contentWindow ||
        message?.protocol !== APP_BRIDGE_PROTOCOL
      ) {
        return;
      }
      if (message.source === "stella-wrapper-ready") {
        iframeRef.current?.contentWindow?.postMessage(
          {
            source: "stella-host-init",
            protocol: APP_BRIDGE_PROTOCOL,
            nonce: frameNonce,
            parentOrigin: new URL(window.location.href).origin,
          },
          appOrigin,
        );
        return;
      }
      if (message.source !== "stella-app" || message.nonce !== frameNonce) {
        return;
      }
      if (message.kind === "stella-operation-result" && message.invocationId) {
        void completeInvocation({
          invocationId: message.invocationId,
          ok: message.ok === true,
          ...(message.resultJson ? { resultJson: message.resultJson } : {}),
          ...(message.errorMessage
            ? { errorMessage: message.errorMessage }
            : {}),
        }).catch(() => undefined);
        return;
      }
      if (!message.id || !message.method) return;
      const method = message.method;
      const respond = (result?: unknown, error?: string) => {
        iframeRef.current?.contentWindow?.postMessage(
          {
            source: "stella-host",
            protocol: APP_BRIDGE_PROTOCOL,
            nonce: frameNonce,
            id: message.id,
            result,
            error,
          },
          appOrigin,
        );
      };
      void (async () => {
        try {
          if (method === "session") {
            respond(await getSession());
            return;
          }
          if (method === "operations/describe") {
            if (!app) throw new Error("App not found.");
            const result = await publishOperations({
              appId: app.appId,
              manifestJson: JSON.stringify(message.params?.operations ?? []),
            });
            respond({ ok: true, eligible: true, ...result });
            return;
          }
          if (STORAGE_BRIDGE_METHODS.has(method)) {
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
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) {
              throw new Error(payload.error ?? "App storage failed.");
            }
            respond(payload);
            return;
          }
          if (method === "share") {
            const shareData = message.params as ShareData;
            if (navigator.share) await navigator.share(shareData);
            else {
              await navigator.clipboard.writeText(
                shareData.url ?? shareData.text ?? "",
              );
            }
            respond({ ok: true });
            return;
          }
          if (method === "fetch") {
            if (!CLOUD_APPS_HOST) {
              throw new Error("Cloud apps are unavailable in this build.");
            }
            const session = await getSession();
            const envelope = message.params ?? {};
            const capabilityResponse = await fetch(
              `${convexSiteUrl()}/api/apps/fetch-capability`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${session.token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(envelope),
              },
            );
            const capabilityBody = (await capabilityResponse.json()) as {
              capability?: string;
              error?: string;
            };
            if (
              !capabilityResponse.ok ||
              typeof capabilityBody.capability !== "string"
            ) {
              throw new Error(
                capabilityBody.error ?? "App fetch authorization failed.",
              );
            }
            const response = await fetch(`${CLOUD_APPS_HOST}/api/apps/fetch`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${capabilityBody.capability}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(envelope),
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
          respond(undefined, errorText(error, "The app request failed."));
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    appUrl,
    getSession,
    app,
    publishOperations,
    completeInvocation,
    frameNonce,
  ]);

  useEffect(() => {
    if (!appUrl || frameState !== "ready" || !pendingInvocations?.length) {
      return;
    }
    const appOrigin = new URL(appUrl).origin;
    for (const invocation of pendingInvocations) {
      if (forwardedInvocationsRef.current.has(invocation.invocationId)) {
        continue;
      }
      let args: unknown;
      try {
        args = JSON.parse(invocation.argsJson);
      } catch {
        forwardedInvocationsRef.current.add(invocation.invocationId);
        void claimInvocation({ invocationId: invocation.invocationId })
          .then(({ claimed }) =>
            claimed
              ? completeInvocation({
                  invocationId: invocation.invocationId,
                  ok: false,
                  errorMessage: "The operation arguments were invalid.",
                })
              : undefined,
          )
          .catch(() =>
            forwardedInvocationsRef.current.delete(invocation.invocationId),
          );
        continue;
      }
      forwardedInvocationsRef.current.add(invocation.invocationId);
      void claimInvocation({ invocationId: invocation.invocationId })
        .then(({ claimed }) => {
          if (!claimed) return;
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: "stella-host",
              protocol: APP_BRIDGE_PROTOCOL,
              nonce: frameNonce,
              kind: "stella-operation",
              invocationId: invocation.invocationId,
              name: invocation.name,
              args,
            },
            appOrigin,
          );
        })
        .catch(() =>
          forwardedInvocationsRef.current.delete(invocation.invocationId),
        );
    }
  }, [
    appUrl,
    frameState,
    pendingInvocations,
    claimInvocation,
    completeInvocation,
    frameNonce,
  ]);

  if (authLoading) {
    return (
      <main className="cloud-app-page cloud-app-page--state" role="status">
        Checking your account…
      </main>
    );
  }
  if (!isAuthenticated) {
    return (
      <main className="cloud-app-page cloud-app-page--state" role="alert">
        <h1>Sign in to open this app</h1>
        <p>Your cloud apps are tied to your Stella account.</p>
      </main>
    );
  }
  if (!CLOUD_APPS_HOST) {
    return (
      <main className="cloud-app-page cloud-app-page--state" role="alert">
        <h1>Cloud apps unavailable</h1>
        <p>This build is missing its cloud Apps host configuration.</p>
      </main>
    );
  }
  if (!apps) {
    return (
      <main className="cloud-app-page cloud-app-page--state" role="status">
        Opening app…
      </main>
    );
  }
  if (!app || !frameUrl) {
    return (
      <main className="cloud-app-page cloud-app-page--state" role="alert">
        <h1>App not found</h1>
        <p>It may have been removed or belongs to another account.</p>
      </main>
    );
  }

  return (
    <main className="cloud-app-page" data-state={frameState}>
      <iframe
        key={`${accountScope}:${app.appId}:${retryKey}`}
        ref={iframeRef}
        className="cloud-app-page__frame"
        src={frameUrl}
        title={app.title}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        allow="clipboard-write"
        referrerPolicy="no-referrer"
        onLoad={() => {
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: "stella-host-init",
              protocol: APP_BRIDGE_PROTOCOL,
              nonce: frameNonce,
              parentOrigin: new URL(window.location.href).origin,
            },
            new URL(frameUrl).origin,
          );
          setFrameState("ready");
          setFrameError(null);
        }}
        onError={() => {
          setFrameState("error");
          setFrameError("The app could not be loaded.");
        }}
      />
      {frameState === "loading" ? (
        <div className="cloud-app-page__overlay" role="status">
          Opening {app.title}…
        </div>
      ) : null}
      {frameState === "error" ? (
        <div className="cloud-app-page__overlay" role="alert">
          <strong>Couldn’t open {app.title}</strong>
          <span>{frameError ?? "The app could not be loaded."}</span>
          <button
            type="button"
            className="pill-btn pill-btn--primary"
            onClick={() => setRetryKey((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
    </main>
  );
}
