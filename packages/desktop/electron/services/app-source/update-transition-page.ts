/**
 * The page inside the update-transition overlay, a transparent view laid
 * over the main window (see update-transition.ts). It only ever sees
 * pictures: main hands it a JPEG screenshot of the window before a change,
 * then the regions where the window differs after it with the after
 * picture's crops of them, and it animates only there.
 *
 * Self-contained on purpose: it has to keep working while the renderer's own
 * source is mid-update, so it is a data: URL built from `transitionPage`'s
 * source and ships inside the main bundle. Nothing in the function may refer
 * to anything outside it.
 *
 * API on `window.__updateTransition` (called by main with executeJavaScript):
 * - `cover(before, live)`: show the before picture over the window, except the
 *   `live` rects (CSS px), which stay live and out of the comparison.
 * - `reveal(items, whole, motion)`: focus-pull each region main found (with the
 *   after picture's crop of it); `whole` when it is the whole window.
 * - `frost(motion)`: frost the covered window for a restart and return the
 *   frosted picture (for the launcher and the next process).
 * - `renderMark(svg, dark, size)`: the mark as a PNG, for the launcher.
 * - `hold(frosted, options)`: show a frosted picture with the Stella mark and
 *   the "Updating Stella" label.
 * - `focusIn(after, motion)`: bring the window into focus from the hold.
 * - `clear()`: drop everything; the live window shows again.
 */

// The page runs in a browser, but main typechecks without the DOM library:
// the few browser APIs it touches are declared here, scoped to this module.
type Keyframe = Record<string, string | number | null>;
type KeyframeAnimationOptions = Record<string, string | number>;
type ImageBitmap = { width: number; height: number };
type Element = any;
declare const document: Element;
declare const window: Element;
declare const OffscreenCanvas: Element;
declare const Image: Element;
declare const requestAnimationFrame: (callback: () => void) => number;
declare const createImageBitmap: (source: Blob) => Promise<ImageBitmap>;

export type Rect = { x: number; y: number; w: number; h: number };
type Motion = { keyframes: Keyframe[]; timing: KeyframeAnimationOptions };

export type FocusPullMotion = { out: Motion; in: Motion };
export type FrostMotion = {
  frost: Motion;
  /** Frosting tint over light and dark windows. */
  tintLight: string;
  tintDark: string;
  /** The frost's end state, for the exported frame: blur in CSS px, saturation. */
  blur: number;
  saturate: number;
};
export type HoldOptions = {
  /** Show the mark and label after this many ms (the label waits 0.7 s in all). */
  labelDelayMs: number;
  dark: boolean;
  label: string;
  markSvg: string;
  appear: Motion;
};
export type FocusInMotion = { focus: Motion; fade: Motion; leave: Motion };
/** A region to focus-pull: where (CSS px), its feather per side (left,
 * top, right, bottom; 0 at the window's edge), and the after picture's crop
 * of it as a data URL. */
export type RevealItem = {
  rect: Rect;
  feather: [number, number, number, number];
  after: string;
};
export type RevealReport = {
  /** Decode and layer setup: the wait before the animation starts. */
  prepMs: number;
};

function transitionPage() {
  const root: Element = document.getElementById("root");
  /** Device pixels per CSS pixel of the pictures. */
  let dpr = window.devicePixelRatio || 1;
  let before: ImageBitmap | null = null;
  /** CSS px rects that stay live: out of the cover and the comparison. */
  let live: Array<[number, number, number, number]> = [];
  let holdLayer: Element | null = null;

  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** Two frames, or half a second if the window stops painting (covered). */
  const painted = () =>
    Promise.race([
      (async () => {
        await frame();
        await frame();
      })(),
      sleep(500),
    ]);
  /** Animations' end, or their length plus a margin if the timeline stalls. */
  const finished = (animations: Array<{ finished: Promise<unknown>; effect: { getComputedTiming(): { endTime: number } } }>) =>
    Promise.race([
      Promise.all(animations.map((animation) => animation.finished)),
      sleep(Math.max(0, ...animations.map((animation) => Number(animation.effect.getComputedTiming().endTime) || 0)) + 500),
    ]);
  const decode = async (url: string) => createImageBitmap(await (await fetch(url)).blob());
  const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

  /**
   * A canvas showing `rect` of a picture at its place in the window. Sides
   * that touch the window's edge are extended by `pad` CSS px of repeated
   * edge pixels, so a blur never pulls in transparency (and with it the
   * sharp live window) from outside.
   */
  function pictureLayer(
    bitmap: ImageBitmap,
    rect: Rect,
    pad: number,
    holes = live,
    origin: { x: number; y: number } = { x: 0, y: 0 },
  ) {
    const { w: vw, h: vh } = viewport();
    const padL = rect.x <= 0 ? pad : 0;
    const padT = rect.y <= 0 ? pad : 0;
    const padR = rect.x + rect.w >= vw ? pad : 0;
    const padB = rect.y + rect.h >= vh ? pad : 0;
    const sx = Math.round((rect.x - origin.x) * dpr);
    const sy = Math.round((rect.y - origin.y) * dpr);
    const sw = Math.min(bitmap.width - sx, Math.round(rect.w * dpr));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.h * dpr));
    const ox = Math.round(padL * dpr);
    const oy = Math.round(padT * dpr);
    const canvas = document.createElement("canvas");
    canvas.width = ox + sw + Math.round(padR * dpr);
    canvas.height = oy + sh + Math.round(padB * dpr);
    const g = canvas.getContext("2d")!;
    g.drawImage(bitmap, sx, sy, sw, sh, ox, oy, sw, sh);
    for (const [hx, hy, hw, hh] of holes) {
      g.clearRect((hx - origin.x) * dpr - sx + ox, (hy - origin.y) * dpr - sy + oy, hw * dpr, hh * dpr);
    }
    if (padL) g.drawImage(canvas, ox, oy, 1, sh, 0, oy, ox, sh);
    if (padR) g.drawImage(canvas, ox + sw - 1, oy, 1, sh, ox + sw, oy, canvas.width - ox - sw, sh);
    if (padT) g.drawImage(canvas, 0, oy, canvas.width, 1, 0, 0, canvas.width, oy);
    if (padB) g.drawImage(canvas, 0, oy + sh - 1, canvas.width, 1, 0, oy + sh, canvas.width, canvas.height - oy - sh);
    Object.assign(canvas.style, {
      position: "absolute",
      left: `${rect.x - padL}px`,
      top: `${rect.y - padT}px`,
      width: `${canvas.width / dpr}px`,
      height: `${canvas.height / dpr}px`,
      willChange: "filter, opacity, transform",
    });
    return canvas;
  }

  async function cover(url: string, liveRects: Array<[number, number, number, number]>) {
    before = await decode(url);
    live = liveRects;
    dpr = before.width / window.innerWidth;
    const { w, h } = viewport();
    holdLayer = null;
    root.replaceChildren(pictureLayer(before, { x: 0, y: 0, w, h }, 0));
    await painted();
  }

  /** The live rects stop being live (the page reloads): show them as pictured. */
  function fillLive() {
    if (!before || live.length === 0) return;
    const { w, h } = viewport();
    live = [];
    root.replaceChildren(pictureLayer(before, { x: 0, y: 0, w, h }, 0));
  }

  /**
   * Focus-pull each region main found from the before picture to the after
   * picture (main sends the after picture's crop of each region), then get
   * out of the way: the live window under it already matches.
   */
  async function reveal(items: RevealItem[], whole: boolean, motion: FocusPullMotion) {
    const called = performance.now();
    const was = before;
    before = null;
    if (!was) {
      root.replaceChildren();
      return { prepMs: 0 };
    }
    const crops = await Promise.all(items.map((item) => decode(item.after)));
    const groups: Element[] = [];
    const runs: Array<() => Promise<unknown>> = [];
    items.forEach(({ rect, feather }, index) => {
      const group = document.createElement("div");
      Object.assign(group.style, { position: "absolute", inset: "0" });
      if (!whole) {
        const mask = `linear-gradient(to right, transparent, #000 ${feather[0]}px, #000 calc(100% - ${feather[2]}px), transparent), linear-gradient(to bottom, transparent, #000 ${feather[1]}px, #000 calc(100% - ${feather[3]}px), transparent)`;
        Object.assign(group.style, {
          maskImage: mask,
          webkitMaskImage: mask,
          maskSize: `${rect.w}px ${rect.h}px`,
          webkitMaskSize: `${rect.w}px ${rect.h}px`,
          maskPosition: `${rect.x}px ${rect.y}px`,
          webkitMaskPosition: `${rect.x}px ${rect.y}px`,
          maskRepeat: "no-repeat",
          webkitMaskRepeat: "no-repeat",
          maskComposite: "intersect",
          webkitMaskComposite: "source-in",
        });
      }
      const next = pictureLayer(crops[index]!, rect, 48, [], rect);
      const prev = pictureLayer(was, rect, 48);
      group.append(next, prev);
      groups.push(group);
      runs.push(() =>
        finished([
          prev.animate(motion.out.keyframes, motion.out.timing),
          next.animate(motion.in.keyframes, motion.in.timing),
        ]),
      );
    });
    // The regions replace the full cover in one frame; outside them the live
    // window already matches the after picture.
    root.replaceChildren(...groups);
    const prepMs = Math.round(performance.now() - called);
    await Promise.all(runs.map((run) => run()));
    root.replaceChildren();
    return { prepMs };
  }

  /** Mean luminance of a picture, 0..1, from a tiny read. */
  function luminance(bitmap: ImageBitmap) {
    const canvas = new OffscreenCanvas(16, 10);
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap, 0, 0, 16, 10);
    const data = g.getImageData(0, 0, 16, 10).data;
    let sum = 0;
    for (let j = 0; j < data.length; j += 4) {
      sum += 0.2126 * data[j]! + 0.7152 * data[j + 1]! + 0.0722 * data[j + 2]!;
    }
    return sum / (data.length / 4) / 255;
  }

  async function frost(motion: FrostMotion) {
    if (!before) throw new Error("Nothing is covered.");
    const picture = before;
    const dark = luminance(picture) < 0.5;
    const tintColor = dark ? motion.tintDark : motion.tintLight;
    const { w, h } = viewport();
    const layer = pictureLayer(picture, { x: 0, y: 0, w, h }, 72, []);
    const tint = document.createElement("div");
    Object.assign(tint.style, { position: "absolute", inset: "0", background: tintColor, opacity: "0" });
    root.replaceChildren(layer, tint);
    await finished([
      layer.animate(motion.frost.keyframes, motion.frost.timing),
      tint.animate([{ opacity: 0 }, { opacity: 1 }], motion.frost.timing),
    ]);
    // The same frosted frame at half resolution (it is all blur) for whoever
    // holds it next: the launcher, then the next process.
    const scale = 0.5;
    const out = new OffscreenCanvas(Math.round(picture.width * scale), Math.round(picture.height * scale));
    const g = out.getContext("2d")!;
    g.filter = `blur(${motion.blur * dpr * scale}px) saturate(${motion.saturate})`;
    const padX = (layer.width - picture.width) / 2;
    const padY = (layer.height - picture.height) / 2;
    g.drawImage(layer, -padX * scale, -padY * scale, layer.width * scale, layer.height * scale);
    g.filter = "none";
    g.fillStyle = tintColor;
    g.fillRect(0, 0, out.width, out.height);
    const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    return { frosted: await toBase64(blob), dark };
  }

  async function toBase64(blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  /** The mark as a PNG in the hold's colors, for the launcher to show natively. */
  async function renderMark(svg: string, dark: boolean, size: number) {
    const color = dark ? "#f5f5f7" : "#1d1d1f";
    const markup = svg
      .replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `)
      .split("currentColor")
      .join(color);
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await image.decode();
    const canvas = new OffscreenCanvas(size, size);
    canvas.getContext("2d").drawImage(image, 0, 0, size, size);
    return toBase64(await canvas.convertToBlob({ type: "image/png" }));
  }

  async function hold(url: string, options: HoldOptions) {
    const frosted = await decode(url);
    const layer = document.createElement("div");
    layer.className = "hold";
    layer.dataset.dark = String(options.dark);
    const picture = document.createElement("canvas");
    picture.width = frosted.width;
    picture.height = frosted.height;
    picture.getContext("2d")!.drawImage(frosted, 0, 0);
    picture.className = "hold-picture";
    const center = document.createElement("div");
    center.className = "hold-center";
    const inner = document.createElement("div");
    inner.className = "hold-inner";
    inner.innerHTML = options.markSvg;
    const label = document.createElement("div");
    label.className = "hold-label";
    label.textContent = options.label;
    inner.append(label);
    center.append(inner);
    layer.append(picture, center);
    root.replaceChildren(layer);
    holdLayer = layer;
    inner.animate(options.appear.keyframes, { ...options.appear.timing, delay: Math.max(0, options.labelDelayMs), fill: "both" });
    // A window that isn't shown yet paints the hold as its first frame.
    if (document.visibilityState === "visible") await painted();
  }

  async function focusIn(url: string, motion: FocusInMotion) {
    const after = await decode(url);
    dpr = after.width / window.innerWidth;
    const { w, h } = viewport();
    const layer = pictureLayer(after, { x: 0, y: 0, w, h }, 72, []);
    const holding = holdLayer;
    holdLayer = null;
    if (!holding) {
      root.replaceChildren();
      return;
    }
    root.insertBefore(layer, holding);
    const inner = holding.querySelector(".hold-inner");
    inner?.animate(motion.leave.keyframes, motion.leave.timing);
    await finished([
      layer.animate(motion.focus.keyframes, motion.focus.timing),
      holding.animate(motion.fade.keyframes, motion.fade.timing),
    ]);
    root.replaceChildren();
  }

  function clear() {
    before = null;
    live = [];
    holdLayer = null;
    root.replaceChildren();
  }

  window.__updateTransition = {
    cover,
    fillLive,
    reveal,
    frost,
    renderMark,
    hold,
    focusIn,
    clear,
  };
}

const STYLE = `
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
#root { position: fixed; inset: 0; overflow: hidden; }
.hold, .hold-picture, .hold-center { position: absolute; inset: 0; }
.hold-picture { width: 100%; height: 100%; }
.hold-center { display: grid; place-items: center; }
.hold-inner { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.hold-inner svg { width: 34px; height: 34px; }
.hold { --fg: #1d1d1f; --dim: rgba(29, 29, 31, 0.45); color: var(--fg); }
.hold[data-dark="true"] { --fg: #f5f5f7; --dim: rgba(245, 245, 247, 0.45); }
/* One moving thing: light passes through the label; the mark stays still. */
.hold-label {
  font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  letter-spacing: -0.01em;
  color: transparent;
  background: linear-gradient(90deg, var(--dim) 0%, var(--dim) 38%, var(--fg) 50%, var(--dim) 62%, var(--dim) 100%);
  background-size: 260% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  animation: shimmer 1.8s linear infinite;
}
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: 0% 0; } }
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div id="root"></div><script>(${transitionPage.toString()})();</script></body></html>`;

export const TRANSITION_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`;
