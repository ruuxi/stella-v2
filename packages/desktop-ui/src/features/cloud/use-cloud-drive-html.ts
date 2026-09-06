/**
 * Fetches an HTML document the cloud `html` tool wrote into the owner's
 * drive. The signed URL is minted at read time by the owner-scoped action;
 * `version` (the canvas's createdAt) forces a refetch when the same slug is
 * overwritten by a later turn.
 */
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { driveApi } from "./cloud-api";

type State = {
  key: string | null;
  html: string | null;
  error: string | null;
  loading: boolean;
};

export const useCloudDriveHtml = (
  drivePath: string | null,
  version?: number,
): { html: string | null; error: string | null; loading: boolean } => {
  const getUrl = useAction(driveApi.getMyDriveFileUrl);
  const key = drivePath ? `${drivePath}:${version ?? 0}` : null;
  const [state, setState] = useState<State>({
    key: null,
    html: null,
    error: null,
    loading: Boolean(drivePath),
  });

  useEffect(() => {
    if (!drivePath || !key) return;
    let cancelled = false;
    const controller = new AbortController();
    setState({ key, html: null, error: null, loading: true });
    void (async () => {
      try {
        const { url } = await getUrl({ path: drivePath });
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Drive file fetch failed (${response.status}).`);
        }
        const html = await response.text();
        if (!cancelled) setState({ key, html, error: null, loading: false });
      } catch (error) {
        if (cancelled) return;
        setState({
          key,
          html: null,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [drivePath, getUrl, key]);

  if (!key) return { html: null, error: null, loading: false };
  if (state.key !== key) return { html: null, error: null, loading: true };
  return { html: state.html, error: state.error, loading: state.loading };
};
