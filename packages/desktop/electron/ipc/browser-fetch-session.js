import path from "node:path";
import { BrowserSession } from "@stella/runtime/kernel/browser-use/client";
import { getStellaBrowserBridgeEnv } from "@stella/runtime/kernel/tools/stella-browser-bridge-config";
import { resolveStellaBrowserRoot } from "../utils/stella-browser-paths.js";
import { PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS } from "./renderer-safe-url.js";

const FETCH_OWNER_ID = "stella-desktop-privileged-fetch";

const IDLE_TAB_REAP_MS = 10_000;

let sharedSession = null;
let reapTimer = null;
let lastLeaseIssuedAt = 0;

const createSession = () => {
  const stellaBrowserRoot = resolveStellaBrowserRoot();

  lastLeaseIssuedAt = Math.max(Date.now(), lastLeaseIssuedAt + 1);
  return new BrowserSession({
    sessionId: FETCH_OWNER_ID,
    cwd: stellaBrowserRoot,
    binaryPath: path.join(stellaBrowserRoot, "bin", "stella-browser.js"),
    env: { ...getStellaBrowserBridgeEnv() },
    commandTimeoutMs: PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS,
    ownerLeaseIssuedAt: lastLeaseIssuedAt,
  });
};

const getSharedSession = () => {
  if (!sharedSession || sharedSession.isDisposed) {
    sharedSession = createSession();
  }
  return sharedSession;
};

const dropSharedSession = (session) => {
  if (sharedSession === session) sharedSession = null;
  void session.dispose().catch(() => {});
};

export const reapBrowserFetchTabs = async () => {
  if (reapTimer) {
    clearTimeout(reapTimer);
    reapTimer = null;
  }
  const session = sharedSession;
  if (!session) return;
  sharedSession = null;
  try {

    await session.command("finalize_tabs", { keep: [] });
  } catch (error) {
    console.warn(
      "[browser-fetch] failed to reap privileged-fetch helper tabs:",
      error?.message ?? error,
    );
  }
  await session.dispose().catch((error) => {
    console.warn(
      "[browser-fetch] failed to dispose privileged-fetch session:",
      error?.message ?? error,
    );
  });
};

const scheduleReap = () => {
  if (reapTimer) clearTimeout(reapTimer);
  reapTimer = setTimeout(() => {
    reapTimer = null;
    void reapBrowserFetchTabs();
  }, IDLE_TAB_REAP_MS);
  reapTimer.unref?.();
};

export const getBrowserCookieHeader = async (targetUrl) => {
  const session = getSharedSession();
  try {
    const response = await session.command("cookies_get", { url: targetUrl });
    const cookies = response.result.data?.cookies ?? [];
    if (cookies.length === 0) return null;
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch (error) {

    dropSharedSession(session);
    throw error;
  } finally {
    scheduleReap();
  }
};
