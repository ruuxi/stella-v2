import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { cloudApi } from "./cloud-api";

export function CloudAppPanel({ slug }: { slug: string }) {
  const { isCloudConversationReady, accountScope } =
    useCloudConversationSession();
  const config = useQuery(
    cloudApi.getCloudRealtimeConfig,
    isCloudConversationReady ? {} : "skip",
  );
  const [state, setState] = useState<{
    url?: string;
    error?: string;
    loaded?: boolean;
  }>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setState({});
    if (!config?.httpOrigin) return;
    let cancelled = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${config.httpOrigin}/owners/me/apps/${encodeURIComponent(slug)}/session`,
          {
            method: "POST",
            headers: await getAuthHeaders(),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(60_000),
            ]),
          },
        );
        const value = await response.json();
        if (
          !response.ok ||
          typeof value.url !== "string" ||
          !Number.isSafeInteger(value.expiresAt)
        )
          throw new Error(value.error ?? "App could not be opened.");
        if (cancelled) return;
        setState({ url: value.url });
        expiry = setTimeout(
          () =>
            setState({
              error: "This app session expired. Reopen it to continue.",
            }),
          Math.max(0, value.expiresAt - Date.now()),
        );
      } catch (e) {
        if (!cancelled)
          setState({
            error: e instanceof Error ? e.message : "App could not be opened.",
          });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(expiry);
    };
  }, [config?.httpOrigin, slug, accountScope, retry]);
  useEffect(() => {
    if (!state.url || state.loaded) return;
    const timeout = setTimeout(
      () =>
        setState({
          error: "App did not finish loading. Try opening it again.",
        }),
      60_000,
    );
    return () => clearTimeout(timeout);
  }, [state.url, state.loaded]);
  if (state.error)
    return (
      <div className="persistent-user-app-status" role="alert">
        <span>{state.error}</span>
        <button onClick={() => setRetry((v) => v + 1)}>Reopen app</button>
      </div>
    );
  return (
    <>
      {!state.loaded && (
        <div className="persistent-user-app-status" role="status">
          Opening app…
        </div>
      )}
      {state.url && (
        <iframe
          title={slug}
          src={state.url}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          onLoad={() => setState((current) => ({ ...current, loaded: true }))}
          onError={() =>
            setState({
              error: "App could not be loaded. Try opening it again.",
            })
          }
          style={{
            width: "100%",
            height: "100%",
            border: 0,
            display: state.loaded ? "block" : "none",
          }}
        />
      )}
    </>
  );
}
