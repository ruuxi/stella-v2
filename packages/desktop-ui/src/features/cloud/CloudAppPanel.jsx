import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";
import { cloudApi } from "./cloud-api";
import { cloudAppUrl, CLOUD_APPS_HOST } from "./cloud-config";
import "../../routes/cloud-app-page.css";

const convexSiteUrl = () => {
  const value = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL,
  );
  if (!value) throw new Error("Stella isn't fully set up yet.");
  return value.replace(/\/+$/, "");
};

export function CloudAppPanel({ slug }) {
  const { isAuthenticated } = useConvexAuth();
  const apps = useQuery(cloudApi.listMyApps, isAuthenticated ? {} : "skip");
  const app = apps?.find((candidate) => candidate.slug === slug);
  const publishOperations = useMutation(cloudApi.publishMyAppOperations);
  const claimInvocation = useMutation(cloudApi.claimOpInvocation);
  const completeInvocation = useMutation(cloudApi.completeOpInvocation);
  const pendingInvocations = useQuery(
    cloudApi.listPendingOpInvocations,
    isAuthenticated && app ? { appId: app.appId } : "skip",
  );
  const forwardedInvocationsRef = useRef(new Set());
  const iframeRef = useRef(null);
  const sessionRef = useRef(null);
  const appUrl = useMemo(() => (app ? cloudAppUrl(app.slug) : null), [app]);
  const frameUrl = useMemo(
    () =>
      appUrl && import.meta.env.DEV
        ? `${appUrl}?stella-platform-check=1`
        : appUrl,
    [appUrl],
  );

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
    if (!response.ok) {
      throw new Error(payload.error ?? "Could not open the app.");
    }
    sessionRef.current = payload;
    return payload;
  }, [app]);

  useEffect(() => {
    if (!appUrl) return;
    const appOrigin = new URL(appUrl).origin;
    const onMessage = (event) => {
      const message = event.data;
      if (
        event.origin !== appOrigin ||
        event.source !== iframeRef.current?.contentWindow ||
        message?.source !== "stella-app"
      ) {
        return;
      }
      if (message.kind === "stella-operation-result" && message.invocationId) {
        void completeInvocation({
          invocationId: message.invocationId,
          ok: message.ok === true,
          resultJson: message.resultJson,
          errorMessage: message.errorMessage,
        }).catch(() => undefined);
        return;
      }
      if (!message.id || !message.method) return;
      const method = message.method;
      const respond = (result, error) => {
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
          if (method === "operations/describe") {
            if (!app) throw new Error("App not found.");
            const result = await publishOperations({
              appId: app.appId,
              manifestJson: JSON.stringify(message.params?.operations ?? []),
            });
            respond({ ok: true, eligible: true, ...result });
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
            if (!response.ok) {
              throw new Error(payload.error ?? "App storage failed.");
            }
            respond(payload);
            return;
          }
          if (method === "share") {
            const shareData = message.params;
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
            const response = await fetch(`${CLOUD_APPS_HOST}/api/apps/fetch`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(message.params ?? {}),
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
  }, [appUrl, getSession, app, publishOperations, completeInvocation]);

  useEffect(() => {
    if (!appUrl || !pendingInvocations?.length) return;
    const appOrigin = new URL(appUrl).origin;
    for (const invocation of pendingInvocations) {
      if (forwardedInvocationsRef.current.has(invocation.invocationId)) {
        continue;
      }
      forwardedInvocationsRef.current.add(invocation.invocationId);
      void claimInvocation({ invocationId: invocation.invocationId })
        .then(({ claimed }) => {
          if (!claimed) return;
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: "stella-host",
              kind: "stella-operation",
              invocationId: invocation.invocationId,
              name: invocation.name,
              args: JSON.parse(invocation.argsJson),
            },
            appOrigin,
          );
        })
        .catch(() =>
          forwardedInvocationsRef.current.delete(invocation.invocationId),
        );
    }
  }, [appUrl, pendingInvocations, claimInvocation]);

  if (!apps) {
    return (
      <main className="cloud-app-page cloud-app-page--state">Opening…</main>
    );
  }
  if (!app || !appUrl) {
    return (
      <main className="cloud-app-page cloud-app-page--state">
        <h1>App not found</h1>
      </main>
    );
  }

  return (
    <main className="cloud-app-page">
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
