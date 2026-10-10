/**
 * Wiring for the "canvas share" feature over the backend's `shares.*` calls.
 * Every canvas the agent writes already has a private link (only its owner
 * can open it); sharing is making that link public. A canvas without a link
 * yet (written signed out, or before links existed) gets one when it is made
 * public. The live list is the `shares.list` view (see
 * `useSharedCanvasLinks`), one canvas's link the `shares.canvas` view (see
 * `useCanvasLink`).
 *
 * The provider is mounted once inside the main app tree. Consumers render
 * nothing when `useCanvasShare()` returns `null`, so shared canvas rendering
 * remains safe outside that provider.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  SHARE_CANVAS_PATTERN,
  type PublishedShare,
  type SavedCanvasShare,
  type ShareLink,
  type ShareVisibility,
} from "@stella/contracts/backend/shares";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { canvasShareBaseUrl } from "@/shared/lib/canvas-share";

export type PublishedCanvasShare = PublishedShare;
export type SharedCanvasLink = ShareLink;
export type SavedCanvasLink = SavedCanvasShare;
export type CanvasLinkVisibility = ShareVisibility;

export type CanvasShareContextValue = {
  /** Public base URL for share links, or null when the domain is pending. */
  baseUrl: string | null;
  publish: (args: {
    html: string;
    title?: string;
  }) => Promise<PublishedCanvasShare>;
  revoke: (args: { slug: string }) => Promise<void>;
  /** Save a canvas to its link (created on first save) at this visibility. */
  save: (args: {
    canvas: string;
    html: string;
    title?: string;
    visibility?: ShareVisibility;
  }) => Promise<SavedCanvasShare>;
  setVisibility: (args: {
    slug: string;
    visibility: ShareVisibility;
  }) => Promise<SavedCanvasShare>;
  /** A URL that opens the link in a browser as its owner. */
  viewLink: (args: { slug: string }) => Promise<string>;
};

const CanvasShareContext = createContext<CanvasShareContextValue | null>(null);

const publish = (args: { html: string; title?: string }) =>
  backendClient.call("shares.publish", args);

const revoke = async ({ slug }: { slug: string }) => {
  await backendClient.call("shares.revoke", { slug });
};

const save: CanvasShareContextValue["save"] = (args) =>
  backendClient.call("shares.save", args);

const setVisibility: CanvasShareContextValue["setVisibility"] = (args) =>
  backendClient.call("shares.setVisibility", args);

const viewLink = async ({ slug }: { slug: string }) =>
  (await backendClient.call("shares.viewLink", { slug })).url;

export function CanvasShareProvider({ children }: { children: ReactNode }) {
  const value = useMemo<CanvasShareContextValue>(
    () => ({
      baseUrl: canvasShareBaseUrl(),
      publish,
      revoke,
      save,
      setVisibility,
      viewLink,
    }),
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

/** The canvas slug a link is saved under, or null when it has none. */
export const canvasLinkKey = (slug: string | undefined): string | null =>
  slug && SHARE_CANVAS_PATTERN.test(slug) ? slug : null;

/** One canvas's link (null before it has one); skipped without a key. */
export const useCanvasLink = (canvas: string | null) =>
  useBackendView("shares.canvas", canvas ? { canvas } : "skip");
