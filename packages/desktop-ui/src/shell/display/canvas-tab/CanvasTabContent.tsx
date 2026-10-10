/**
 * Canvas viewer for one HTML artifact the orchestrator produced via the
 * `html` tool: a share bar over a sandboxed iframe. On desktop the iframe
 * loads the canvas from `stella-canvas://`, its own origin with its own CSP
 * (CDN scripts, styles and fonts load; the app's DOM, storage and preload API
 * are out of reach), where main injects the Ask Stella / link bridge. Which
 * canvas is showing is the Files section's business, so this takes the item
 * it should render rather than picking one.
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import { DisplayFileSourceContext } from "@/shared/hooks/display-file-source";
import { useCloudDriveHtml } from "@/features/cloud/use-cloud-drive-html";
import { openExternalUrl } from "@/platform/electron/open-external";
import { deviceFileMissingMessage } from "@stella/contracts/device-files";
import { CanvasIllustration } from "../illustrations/CanvasIllustration";
import { CanvasShareBar } from "./CanvasShareBar";
import type { CanvasHtmlItem } from "./canvas-items";
import { classifyCanvasNavigation } from "./canvas-navigation";
import { useT } from "@/shared/i18n";
import "./canvas-tab.css";
import type { ReactNode } from "react";

const decoder = new TextDecoder("utf-8");

/**
 * `src`: a `stella-canvas://` document. `srcDoc`: the website, which has no
 * canvas origin; there the HTML runs under the page's own CSP.
 */
type CanvasFrame = { src: string } | { srcDoc: string };

const canvasUrlApi = () => {
    const display = typeof window === "undefined" ? undefined : window.electronAPI?.display;
    return typeof display?.canvasFileUrl === "function" &&
        typeof display.canvasHtmlUrl === "function"
        ? display
        : null;
};
const errorMessage = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/u, "");
const CanvasLoadingDots = () => (<span className="canvas-tab__loading-dots" aria-hidden>
    <span>.</span>
    <span>.</span>
    <span>.</span>
  </span>);
const CanvasIllustrationSpot = ({ label }: { label?: ReactNode }) => (<div className="canvas-tab__illustration-spot">
    <div className="canvas-tab__illustration-art">
      <CanvasIllustration />
    </div>
    {label ? (<div className="canvas-tab__illustration-label">{label}</div>) : null}
  </div>);
/**
 * Local canvas on desktop: main hands back the URL (a file under `outputs/`
 * is served from disk; any other is read there and held in memory).
 */
const LocalFileCanvasHeroFrameContent = ({ item }: { item: CanvasHtmlItem }) => {
    // Same-slug canvases overwrite the same file in place; folding
    // `createdAt` into the key re-resolves (and the iframe below remounts)
    // so a re-opened/re-rendered canvas never shows stale content.
    const key = `${item.filePath}\0${item.createdAt}`;
    const [resolved, setResolved] = useState<{
        key: string;
        src: string | null;
        error: string | null;
    } | null>(null);
    useEffect(() => {
        const api = canvasUrlApi();
        if (!api)
            return;
        let cancelled = false;
        void api.canvasFileUrl(item.filePath).then((result) => {
            if (cancelled)
                return;
            setResolved("url" in result
                ? { key, src: result.url, error: null }
                : { key, src: null, error: result.message ?? deviceFileMissingMessage("deleted", item.filePath) });
        }, (caught: unknown) => {
            if (!cancelled)
                setResolved({ key, src: null, error: errorMessage(caught) });
        });
        return () => {
            cancelled = true;
        };
    }, [item.filePath, key]);
    const settled = resolved?.key === key ? resolved : null;
    return <CanvasHeroFrameDocument item={item} frame={settled?.src ? { src: settled.src } : null} error={settled?.error ?? null} loading={!settled}/>;
};
/**
 * HTML already in hand (a cloud canvas, a Drive file): on desktop it is
 * registered with main and loaded from its `stella-canvas://` URL.
 */
const HtmlCanvasHeroFrameContent = ({ item, html, error, loading, }: {
  item: CanvasHtmlItem;
  html: string;
  error: string | null;
  loading: boolean;
}) => {
    const hasCanvasOrigin = canvasUrlApi() !== null;
    const [registered, setRegistered] = useState<{
        html: string;
        src: string | null;
        error: string | null;
    } | null>(null);
    useEffect(() => {
        const api = canvasUrlApi();
        if (!api || !html)
            return;
        let cancelled = false;
        void api.canvasHtmlUrl(html).then(({ url }) => {
            if (!cancelled)
                setRegistered({ html, src: url, error: null });
        }, (caught: unknown) => {
            if (!cancelled)
                setRegistered({ html, src: null, error: errorMessage(caught) });
        });
        return () => {
            cancelled = true;
        };
    }, [html]);
    if (!hasCanvasOrigin) {
        return <CanvasHeroFrameDocument item={item} frame={html ? { srcDoc: html } : null} error={error} loading={loading}/>;
    }
    const settled = html && registered?.html === html ? registered : null;
    return <CanvasHeroFrameDocument item={item} frame={settled?.src ? { src: settled.src } : null} error={error ?? settled?.error ?? null} loading={loading || (Boolean(html) && !settled)}/>;
};
/** Bytes over the display bridge: a Drive file, or the website's device copies. */
const BytesCanvasHeroFrameContent = ({ item }: { item: CanvasHtmlItem }) => {
    const { bytes, error, loading } = useDisplayFileBytes(item.filePath, "Canvas preview requires the Stella desktop app.", undefined, item.createdAt);
    const html = useMemo(() => (bytes ? decoder.decode(bytes) : ""), [bytes]);
    return <HtmlCanvasHeroFrameContent item={item} html={html} error={error} loading={loading}/>;
};
/** Cloud canvas: the html the cloud `html` tool wrote into the owner's drive. */
const CloudCanvasHeroFrameContent = ({ item }: { item: CanvasHtmlItem }) => {
    const { html, error, loading } = useCloudDriveHtml(item.filePath, item.createdAt);
    return <HtmlCanvasHeroFrameContent item={item} html={html ?? ""} error={error} loading={loading}/>;
};
const CanvasHeroFrameContent = ({ item }: { item: CanvasHtmlItem }) => {
    const fileSource = useContext(DisplayFileSourceContext);
    if (item.driveBacked)
        return <CloudCanvasHeroFrameContent item={item}/>;
    if (fileSource || !canvasUrlApi())
        return <BytesCanvasHeroFrameContent item={item}/>;
    return <LocalFileCanvasHeroFrameContent item={item}/>;
};
const CanvasHeroFrameDocument = ({ item, frame, error, loading, }: {
  item: CanvasHtmlItem;
  frame: CanvasFrame | null;
  error: string | null;
  loading: boolean;
}) => {
    const t = useT();
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const loadCountRef = useRef(0);
    const [navigationReset, setNavigationReset] = useState(0);
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            // The canvas origin is opaque ("null"), so the sender is
            // identified by its window, never by origin.
            if (event.source !== iframeRef.current?.contentWindow)
                return;
            const data = event.data;
            if (data?.type === "stella:canvas-open-external" &&
                typeof data.url === "string") {
                const navigation = classifyCanvasNavigation(data.url);
                if (navigation.kind === "external") {
                    openExternalUrl(navigation.url);
                }
            }
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, []);
    if (error) {
        return (<div className="canvas-tab__frame-state canvas-tab__frame-state--error" title={item.filePath}>
        {error || t("shell.display.canvas.loadFailed")}
      </div>);
    }
    if (loading || !frame) {
        return (<CanvasIllustrationSpot label={<div className="canvas-tab__loading-label">
            {t("shell.display.canvas.loading")}
            <CanvasLoadingDots />
          </div>}/>);
    }
    return (<div className="canvas-tab__frame-wrap">
      <iframe key={`${item.id}:${item.createdAt}:${navigationReset}`} ref={iframeRef} title={item.title} className="canvas-tab__iframe" {...("src" in frame
            ? { src: frame.src, sandbox: "allow-scripts" }
            : { srcDoc: frame.srcDoc, sandbox: "allow-scripts allow-popups allow-modals allow-forms" })} referrerPolicy="no-referrer" onLoad={() => {
            // The first load is the canvas document. Main stops a canvas
            // navigating itself, so a later load means something got past
            // that; remount the original document instead of leaving a
            // broken frame.
            loadCountRef.current += 1;
            if (loadCountRef.current > 1) {
                loadCountRef.current = 0;
                setNavigationReset((value) => value + 1);
            }
        }}/>
    </div>);
};
const CanvasHeroFrame = ({ item, panelOpen, }: {
  item: CanvasHtmlItem;
  panelOpen: boolean;
}) => {
    const t = useT();
    const [ready, setReady] = useState(false);
    useEffect(() => {
        if (!panelOpen || ready)
            return;
        // A canvas can already be mounted in the hidden keep-alive host when a
        // sidebar artifact is clicked. Starting its load (or replacing its
        // iframe) during that click blocks Chromium's renderer before the
        // panel gets a chance to paint. Wait for a frame of the open shell first;
        // the keyed boundary below also makes a same-path overwrite start from
        // this lightweight loading state instead of remounting with stale bytes.
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => setReady(true));
        });
        return () => cancelAnimationFrame(frame);
    }, [panelOpen, ready]);
    if (!ready) {
        return (<CanvasIllustrationSpot label={<div className="canvas-tab__loading-label">
            {t("shell.display.canvas.loading")}
            <CanvasLoadingDots />
          </div>}/>);
    }
    return <CanvasHeroFrameContent item={item}/>;
};
export const CanvasTabContent = ({ item }: { item: CanvasHtmlItem }) => {
    const panelOpen = useDisplayPanelOpen();
    return (<div className="canvas-tab">
      <div className="canvas-tab__hero">
        <CanvasShareBar item={item}/>
        <CanvasHeroFrame key={`${item.id}:${item.createdAt}`} item={item} panelOpen={panelOpen}/>
      </div>
    </div>);
};
