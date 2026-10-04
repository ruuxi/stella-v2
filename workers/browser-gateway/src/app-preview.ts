import { launch } from "@cloudflare/playwright";
import type { BrowserGatewayEnv } from "./profile-session-core.js";
import { GatewayError } from "./errors.js";

/**
 * A still of an owner's workspace app for the chat's app card. The caller
 * (cloud-builder, over the service binding) mints a short-lived signed app
 * URL and stores the image; this only loads that one page in a throwaway
 * browser with no profile, waits for it to settle, and returns a JPEG.
 */
const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 20_000;
const SETTLE_MS = 900;

const previewUrl = (body: unknown): string => {
  const value =
    body && typeof body === "object" ? (body as { url?: unknown }).url : null;
  if (typeof value !== "string" || value.length > 4096)
    throw new GatewayError("bad_request", 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError("bad_request", 400);
  }
  if (url.protocol !== "https:" || !url.pathname.startsWith("/workspace-apps/"))
    throw new GatewayError("bad_request", 400);
  return url.toString();
};

export async function captureAppPreview(
  env: BrowserGatewayEnv,
  body: unknown,
): Promise<Response> {
  const url = previewUrl(body);
  const browser = await launch(env.BROWSER, { keep_alive: 10_000 }).catch(() => {
    throw new GatewayError("browser_unavailable", 503);
  });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page
      .goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS })
      .catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
    const image = await page.screenshot({ type: "jpeg", quality: 72 });
    return new Response(new Uint8Array(image), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      },
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
