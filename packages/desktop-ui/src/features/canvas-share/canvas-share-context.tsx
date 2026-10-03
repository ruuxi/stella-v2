/**
 * Wiring for the "canvas share" feature (publish a canvas to a public URL,
 * list your active shares, revoke them) over the backend's `shares.*` calls.
 * The live list is the `shares.list` view (see `useSharedCanvasLinks`).
 *
 * The provider is mounted once inside the main app tree. Consumers render
 * nothing when `useCanvasShare()` returns `null`, so shared canvas rendering
 * remains safe outside that provider.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  PublishedShare,
  ShareLink,
} from "@stella/contracts/backend/shares";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { canvasShareBaseUrl } from "@/shared/lib/canvas-share";

export type PublishedCanvasShare = PublishedShare;
export type SharedCanvasLink = ShareLink;

export type CanvasShareContextValue = {
  /** Public base URL for share links, or null when the domain is pending. */
  baseUrl: string | null;
  publish: (args: {
    html: string;
    title?: string;
  }) => Promise<PublishedCanvasShare>;
  revoke: (args: { slug: string }) => Promise<void>;
};

const CanvasShareContext = createContext<CanvasShareContextValue | null>(null);

const publish = (args: { html: string; title?: string }) =>
  backendClient.call("shares.publish", args);

const revoke = async ({ slug }: { slug: string }) => {
  await backendClient.call("shares.revoke", { slug });
};

export function CanvasShareProvider({ children }: { children: ReactNode }) {
  const value = useMemo<CanvasShareContextValue>(
    () => ({ baseUrl: canvasShareBaseUrl(), publish, revoke }),
    [],
  );

  return (
    <CanvasShareContext.Provider value={value}>
      {children}
    </CanvasShareContext.Provider>
  );
}

/**
 * Returns the canvas-share API, or `null` when rendered outside the provider.
 * Callers must no-op or hide UI on `null`.
 */
export const useCanvasShare = (): CanvasShareContextValue | null =>
  useContext(CanvasShareContext);

/** The account's live shares, newest first. */
export const useSharedCanvasLinks = () => useBackendView("shares.list", {});
