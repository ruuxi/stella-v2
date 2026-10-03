export const CHAT_FRAME_ID = "stella-chat-frame";
export const CHAT_APP_PATH = "/chat-app/index.html";

/**
 * Points the chat iframe at the renderer. OAuth returns a short-lived
 * one-time token in the URL fragment. Fragments never reach Next, so transfer
 * that credential once into the same-origin renderer iframe and immediately
 * erase it from the public address bar.
 *
 * Self-contained (globals and arguments only) because it also runs as an
 * inline script straight after the iframe in the server HTML. That starts the
 * renderer download during HTML parse instead of after the page's own
 * JavaScript loads and hydrates. A no-op once the frame has a source, so the
 * hydrated fallback never navigates the frame twice.
 *
 * An owner who changed Stella's UI has their own renderer under
 * `/chat-app/u/<fork>/<tree>/`; the renderer stores that path in
 * `stella:web-renderer` (see `web-renderer-switch.ts` in desktop-ui), and the
 * frame starts there instead of the shared build.
 */
export function adoptChatFrameSource(frameId: string, appPath: string): void {
  const frame = document.getElementById(frameId);
  if (!frame || frame.getAttribute("src")) return;
  let source = appPath;
  try {
    const own = window.localStorage.getItem("stella:web-renderer");
    if (own && /^\/chat-app\/u\/u-[0-9a-f]{24}\/(?:[0-9a-f]{40}|[0-9a-f]{64})\/$/.test(own)) {
      source = `${own}index.html`;
    }
  } catch {
    // Storage blocked: the shared build.
  }
  const rawFragment = window.location.hash.replace(/^#\??/, "");
  const containsHandoff =
    rawFragment.length > 0 && new URLSearchParams(rawFragment).has("ott");
  frame.setAttribute(
    "src",
    `${source}${containsHandoff ? window.location.hash : ""}`,
  );
  if (containsHandoff) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
}

export const CHAT_FRAME_BOOT_SCRIPT = `(${adoptChatFrameSource.toString()})(${JSON.stringify(CHAT_FRAME_ID)},${JSON.stringify(CHAT_APP_PATH)});`;
