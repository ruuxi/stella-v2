import {
  readConfiguredConvexSiteUrl,
  readConfiguredConvexUrl,
} from "@/shared/lib/convex-urls";

export type RenderedAcceptanceTarget = {
  convexUrl: string;
  convexSiteUrl: string;
};

/**
 * Dev-server-only observation seam for the strict rendered acceptance driver.
 *
 * It reads the exact Vite values used to construct the renderer's Convex and
 * auth clients. The CDP driver hashes these values inside the page before they
 * cross the protocol boundary. Release builds cannot call this seam.
 */
export const readRenderedAcceptanceTarget = (): RenderedAcceptanceTarget => {
  if (!import.meta.env.DEV) {
    throw new Error("Rendered acceptance target is available only in dev.");
  }
  if (!/^(?:127\.0\.0\.1|localhost)$/u.test(window.location.hostname)) {
    throw new Error("Rendered acceptance target requires a loopback shell.");
  }
  const convexUrl = readConfiguredConvexUrl(
    import.meta.env.VITE_CONVEX_URL as string | undefined,
  );
  const convexSiteUrl = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!convexUrl || !convexSiteUrl) {
    throw new Error("Rendered acceptance target is incomplete.");
  }
  return { convexUrl, convexSiteUrl };
};
