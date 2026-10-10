import { getSiteUrl } from "@/lib/site-url";
import { CHAT_FRAME_BOOT_SCRIPT, CHAT_FRAME_ID } from "./chat-frame-source";

export const dynamic = "force-static";

const TITLE = "Chat with Stella | Stella";
const DESCRIPTION =
  "Use Stella from the web, with cloud execution and your connected computers.";
const OG_IMAGE_ALT =
  "Stella — your personal AI assistant in your browser, on desktop, and on mobile.";
const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID?.trim() || "";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const THEME_SCRIPT = `(() => {
  var dark = true;
  try {
    var themeId = localStorage.getItem("stella-theme-id");
    var mode = localStorage.getItem("stella-color-mode") || "dark";
    if (themeId === "pearl" || themeId === "light") dark = false;
    else if (themeId !== "noir" && themeId !== "dark") {
      if (mode === "light") dark = false;
      else if (mode === "system" && window.matchMedia && !window.matchMedia("(prefers-color-scheme: dark)").matches) dark = false;
    }
  } catch (e) {}
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();`;

const googleAdsScript = (id: string) => `(() => {
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", ${JSON.stringify(id)});
  var load = function () {
    if (document.getElementById("google-ads-tag")) return;
    var script = document.createElement("script");
    script.id = "google-ads-tag";
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(${JSON.stringify(id)});
    document.head.appendChild(script);
  };
  var schedule = function () { setTimeout(load, 3000); };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
  window.addEventListener("pointerdown", load, { once: true, passive: true });
  window.addEventListener("keydown", load, { once: true });
  window.addEventListener("touchstart", load, { once: true, passive: true });
})();`;

const STYLE = `html,body{margin:0;height:100%;overflow:hidden;background:#0f0f0d;color-scheme:dark}
html[data-theme="light"],html[data-theme="light"] body{background:#fdfdfb;color-scheme:light}
#${CHAT_FRAME_ID}{position:fixed;inset:0;display:block;width:100%;height:100dvh;border:0;background:transparent}`;

const renderChatShell = () => {
  const site = getSiteUrl();
  const canonical = new URL("/chat", site).href;
  const ogImage = new URL("/og.png", site).href;
  const meta = (attribute: "name" | "property", key: string, content: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(content)}">`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(TITLE)}</title>`,
    meta("name", "description", DESCRIPTION),
    meta("name", "application-name", "Stella"),
    meta("name", "robots", "index, follow"),
    `<link rel="canonical" href="${canonical}">`,
    meta("property", "og:title", TITLE),
    meta("property", "og:description", DESCRIPTION),
    meta("property", "og:url", canonical),
    meta("property", "og:site_name", "Stella"),
    meta("property", "og:locale", "en_US"),
    meta("property", "og:type", "website"),
    meta("property", "og:image", ogImage),
    meta("property", "og:image:width", "1200"),
    meta("property", "og:image:height", "630"),
    meta("property", "og:image:alt", OG_IMAGE_ALT),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:site", "@stella"),
    meta("name", "twitter:title", TITLE),
    meta("name", "twitter:description", DESCRIPTION),
    meta("name", "twitter:image", ogImage),
    '<link rel="icon" href="/favicon.ico" sizes="16x16">',
    '<link rel="icon" href="/icon.png" type="image/png" sizes="192x192">',
    '<link rel="apple-touch-icon" href="/apple-icon.png" sizes="180x180">',
    '<link rel="manifest" href="/manifest.webmanifest">',
    `<script>${THEME_SCRIPT}</script>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    `<iframe id="${CHAT_FRAME_ID}" title="Stella chat" allow="microphone; clipboard-read; clipboard-write"></iframe>`,
    `<script>${CHAT_FRAME_BOOT_SCRIPT}</script>`,
    ...(GOOGLE_ADS_ID ? [`<script>${googleAdsScript(GOOGLE_ADS_ID)}</script>`] : []),
    "</body>",
    "</html>",
  ].join("\n");
};

export function GET() {
  return new Response(renderChatShell(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
