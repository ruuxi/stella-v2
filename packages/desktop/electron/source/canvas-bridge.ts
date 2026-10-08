/**
 * The script every canvas document is served with (see canvas-protocol.ts).
 *
 * A canvas runs on an opaque origin, so this is its only line to the app, and
 * it is postMessage: link and form destinations go to the parent to open
 * externally, text selections and `[data-stella-compose]` targets feed the
 * Ask Stella chip. The parent checks that each message comes from the canvas
 * iframe's window before acting on it.
 */
const CANVAS_BRIDGE_SCRIPT = String.raw`
(() => {
  const navigate = (rawHref) => {
    const href = rawHref.trim();
    if (href.startsWith("#")) {
      const fragment = decodeURIComponent(href.slice(1));
      if (!fragment) {
        window.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      const target = document.getElementById(fragment) ||
        document.querySelector('[name="' + CSS.escape(fragment) + '"]');
      target?.scrollIntoView();
      return;
    }
    try {
      const url = new URL(href);
      if (url.protocol === "http:" || url.protocol === "https:") {
        parent.postMessage({ type: "stella:canvas-open-external", url: url.href }, "*");
      }
    } catch {
      // A relative destination cannot exist outside this single-file canvas.
    }
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    const anchor = target && typeof target.closest === "function"
      ? target.closest("a[href]")
      : null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(anchor.getAttribute("href") || "");
  }, true);

  document.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target;
    if (form && typeof form.getAttribute === "function") {
      navigate(form.getAttribute("action") || "");
    }
  }, true);

  const composeButton = document.createElement("button");
  composeButton.type = "button";
  composeButton.textContent = "Ask Stella";
  composeButton.setAttribute("aria-label", "Ask Stella about this");
  Object.assign(composeButton.style, {
    position: "fixed",
    zIndex: "2147483647",
    display: "none",
    alignItems: "center",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: "999px",
    background: "rgba(20,20,22,0.92)",
    color: "white",
    boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
    padding: "5px 9px",
    font: "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    cursor: "default",
  });
  (document.body || document.documentElement).appendChild(composeButton);
  let activeComposeText = "";
  let hideTimer = 0;

  const findComposeTarget = (target) => {
    if (!target || typeof target.closest !== "function") return null;
    return target.closest("[data-stella-compose]");
  };

  const readComposeText = (target) => {
    const raw = target.getAttribute("data-stella-compose") || target.textContent || "";
    return raw.replace(/\s+/g, " ").trim();
  };

  const showComposeButton = (target) => {
    window.clearTimeout(hideTimer);
    const text = readComposeText(target);
    if (!text) return;
    activeComposeText = text;
    const rect = target.getBoundingClientRect();
    composeButton.style.left = Math.max(8, Math.min(window.innerWidth - 104, rect.right - 96)) + "px";
    composeButton.style.top = Math.max(8, rect.top + 8) + "px";
    composeButton.style.display = "inline-flex";
  };

  const hideComposeButtonSoon = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      composeButton.style.display = "none";
      activeComposeText = "";
    }, 180);
  };

  document.addEventListener("mouseover", (event) => {
    const target = findComposeTarget(event.target);
    if (target) showComposeButton(target);
  }, true);
  document.addEventListener("mouseout", (event) => {
    const target = findComposeTarget(event.target);
    if (target) hideComposeButtonSoon();
  }, true);
  composeButton.addEventListener("mouseover", () => window.clearTimeout(hideTimer));
  composeButton.addEventListener("mouseout", hideComposeButtonSoon);
  composeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeComposeText) {
      parent.postMessage({ type: "stella:canvas-compose", text: activeComposeText }, "*");
    }
    composeButton.style.display = "none";
  });

  const post = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    const text = selection.toString();
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || !Number.isFinite(rect.left)) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    parent.postMessage({
      type: "stella:canvas-selection",
      selected: true,
      text,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    }, "*");
  };
  window.addEventListener("mouseup", () => setTimeout(post, 0), true);
  document.addEventListener("selectionchange", () => setTimeout(post, 0));
  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    if (event.data && event.data.type === "stella:canvas-selection-clear") {
      window.getSelection()?.removeAllRanges();
      post();
    }
  });
})();
`;

const BRIDGE_TAG = `<script>${CANVAS_BRIDGE_SCRIPT}</script>`;

/** Insert the bridge before the document's last `</body>`, or append it. */
export const injectCanvasBridge = (html: string): string => {
  const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
  if (bodyEnd === -1) return `${html}${BRIDGE_TAG}`;
  return `${html.slice(0, bodyEnd)}${BRIDGE_TAG}${html.slice(bodyEnd)}`;
};
