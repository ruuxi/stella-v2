import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { type BrowserWindow, type NativeImage, WebContentsView } from "electron";
import { springEasing } from "@stella/contracts/desktop/spring";
import { diffRegions, type LiveRect, type Rect } from "./picture-diff.js";
import {
  TRANSITION_PAGE_URL,
  type FocusInMotion,
  type FocusPullMotion,
  type FrostMotion,
  type HoldOptions,
  type RevealItem,
  type RevealReport,
} from "./update-transition-page.js";

/**
 * How a change to Stella takes effect on screen, using nothing but pictures
 * of the window: no knowledge of what changed or how the UI is built.
 *
 * Renderer changes: picture the window, cover it with that picture (a
 * transparent view laid over the window, so the swap underneath never
 * flashes), swap, picture it again, and hand both pictures to the cover,
 * which focus-pulls only where they differ (the whole window when most of it
 * does) and gets out of the way. Captures stay JPEG end to end: encoding
 * costs ~11 ms where a raw bitmap costs ~40 ms on a Retina window.
 *
 * Restarts: picture and frost the window, keep the frosted frame on disk and
 * with the launcher while the process restarts, show it again with the mark
 * and "Updating Stella" when the next process opens its window, and focus
 * into the live window once it is ready.
 */

/** A window under its own picture, ready for the swap. */
export type CoveredWindow = {
  /** Run the swap, then focus-pull from the old picture to the new window. */
  reveal<T>(swap: () => Promise<T>): Promise<T>;
  /** Uncover without swapping. */
  cancel(): Promise<void>;
};

export type UpdateHold = {
  /** The frosted frame, a JPEG beside the hold record. */
  image: string;
  /** The mark in the hold's colors, a PNG for the launcher. */
  mark: string;
  /** "Updating Stella", in the user's language. */
  label: string;
  /** When the update started holding, ms since epoch: paces the label. */
  since: number;
  dark: boolean;
  /** The window's frame in screen coordinates, for the launcher. */
  frame: { x: number; y: number; width: number; height: number };
};

type UpdateTransitionOptions = {
  getWindow: () => BrowserWindow | null;
  /** The main window's session partition: the overlay shares it. */
  partition: string;
  /** Directory for the hold carried across a restart. */
  holdDir: string;
  /** "Updating Stella", in the user's language. */
  holdLabel: () => string;
  /** Tell the launcher to hold the frame between processes (no-op without one). */
  onHold?: (hold: UpdateHold) => void;
  log: (event: string, data: Record<string, unknown>) => void;
};

/** Longest a step may take before the transition gives up and uncovers. */
const STEP_TIMEOUT_MS = 6_000;
/** Longest a window capture may take. */
const CAPTURE_TIMEOUT_MS = 2_000;
/** Longest a reload or relaunch may keep the window covered. */
const READY_TIMEOUT_MS = 8_000;
/** A hold older than this is from a restart that never came back. */
const HOLD_MAX_AGE_MS = 60_000;
/** The mark and label wait this long, so a quick restart never shows them. */
const LABEL_DELAY_MS = 700;
const HOLD_RECORD = "update-hold.json";
const HOLD_IMAGE = "update-hold.jpg";
const HOLD_MARK = "update-hold-mark.png";
/** The mark's pixel size for the launcher: 34 pt at up to 3x. */
const HOLD_MARK_PX = 102;

const timeout = <T>(promise: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const jpegUrl = (image: NativeImage) =>
  `data:image/jpeg;base64,${image.toJPEG(100).toString("base64")}`;

/** A quarter-resolution bitmap of a picture, for comparing (~5 ms on Retina). */
const quarter = (image: NativeImage) => {
  const { width, height } = image.getSize();
  const w = Math.max(1, Math.round(width / 4));
  const h = Math.max(1, Math.round(height / 4));
  return { w, h, pixels: image.resize({ width: w, height: h, quality: "good" }).toBitmap() };
};

/** The focus pull feathers out over this margin (CSS px) around a region. */
const FEATHER = 28;

/** A region grown by `margin` on every side, kept inside the window. */
const grow = (rect: Rect, margin: number, vw: number, vh: number): Rect => {
  const x = Math.max(0, rect.x - margin);
  const y = Math.max(0, rect.y - margin);
  return {
    x,
    y,
    w: Math.min(vw, rect.x + rect.w + margin) - x,
    h: Math.min(vh, rect.y + rect.h + margin) - y,
  };
};

/** Feather per side (left, top, right, bottom): none where the window's edge is. */
const edges = (rect: Rect, feather: number, vw: number, vh: number): RevealItem["feather"] => [
  rect.x <= 0 ? 0 : feather,
  rect.y <= 0 ? 0 : feather,
  rect.x + rect.w >= vw ? 0 : feather,
  rect.y + rect.h >= vh ? 0 : feather,
];

const spring = (duration: number, bounce: number, extra: KeyframeTiming = {}) => {
  const { easing, ms } = springEasing(duration, bounce);
  return { duration: ms, easing, ...extra };
};
type KeyframeTiming = { delay?: number; fill?: string };

/** The old frame defocuses first; the two trade places only while both are
 * soft, so there is never a legible double image; then the new one sharpens. */
const focusPull = (): FocusPullMotion => ({
  out: {
    keyframes: [
      { opacity: 1, filter: "blur(0px)", easing: "cubic-bezier(.5,0,.9,.5)" },
      { opacity: 1, filter: "blur(12px)", offset: 0.55, easing: "linear" },
      { opacity: 0, filter: "blur(14px)" },
    ],
    timing: { duration: 250, fill: "forwards" },
  },
  in: {
    keyframes: [{ filter: "blur(12px)" }, { filter: "blur(0px)" }],
    timing: spring(0.48, 0, { delay: 150, fill: "both" }),
  },
});

const FROST_BLUR = 26;
const FROST_SATURATE = 1.6;
const frost = (): FrostMotion => ({
  frost: {
    keyframes: [
      { filter: "blur(0px) saturate(1)" },
      { filter: `blur(${FROST_BLUR}px) saturate(${FROST_SATURATE})` },
    ],
    timing: spring(0.55, 0, { fill: "forwards" }),
  },
  tintLight: "rgba(255, 255, 255, 0.46)",
  tintDark: "rgba(28, 28, 30, 0.40)",
  blur: FROST_BLUR,
  saturate: FROST_SATURATE,
});

const appear = () => ({
  keyframes: [
    { opacity: 0, filter: "blur(6px)", transform: "scale(0.96)" },
    { opacity: 1, filter: "blur(0px)", transform: "scale(1)" },
  ],
  timing: spring(0.5, 0),
});

const focusIn = (): FocusInMotion => ({
  focus: {
    keyframes: [
      { filter: "blur(18px)", transform: "scale(1.014)" },
      { filter: "blur(0px)", transform: "scale(1)" },
    ],
    timing: spring(0.6, 0, { delay: 90, fill: "both" }),
  },
  fade: {
    keyframes: [{ opacity: 1 }, { opacity: 0 }],
    timing: { duration: 440, delay: 90, easing: "cubic-bezier(.2,.6,.3,1)", fill: "forwards" },
  },
  leave: {
    keyframes: [
      { opacity: 1, filter: "blur(0px)", transform: "scale(1)" },
      { opacity: 0, filter: "blur(6px)", transform: "scale(0.97)" },
    ],
    timing: { duration: 200, easing: "ease-in", fill: "forwards" },
  },
});

/** The Stella mark (packages/desktop-ui/public/stella-logo.svg), inline. */
const MARK_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><defs><path id="ut-mark" d="M474.1 154.1C269 172.2 211.6 334.4 372.3 442C377.4 445.4 377.7 445.3 362.3 447.8C215.3 471.8 127.8 569.9 162 672.2C210.1 816.2 463.2 910.8 632.5 848C759.2 801 768.8 684.2 653.7 590.5C642.2 581.1 641 582.3 665 579C815.2 558.3 903.1 453.7 861 345.6C815.4 228.5 636.1 139.7 474.1 154.1Z M601 245.4C860.8 283.4 917.2 523.1 678 572.4C638.3 580.6 643.8 581.7 610.7 558.7C582.1 538.9 559 531.1 522.5 529.1C490.2 527.2 464.6 518.6 442.6 502C436.1 497.1 435.7 497 438 501.8C453.8 534.5 450.4 575.2 427.6 626.2C424.8 632.5 425.3 633.5 429.1 629.4C490.6 562.9 565.8 559.2 635 619.2C762 729.4 590.3 855.3 383.2 803.9C190.7 756.1 118.4 604 241.5 505.5C284.9 470.7 369 441.2 388.8 453.8C393 456.5 399.3 460.3 402.8 462.4C406.3 464.4 412.6 468.7 416.8 471.9C454.3 500.4 484.7 512.2 527.5 515C547 516.2 560.7 519.2 575.9 525.4C582.1 527.9 587.3 530 587.5 530C587.7 530 586.3 526.7 584.5 522.7C569.2 489.7 572.5 449.2 594 403.3C597.9 394.9 597.9 394.9 592 400.2C588.7 403.1 582.1 409 577.3 413.3C527.7 457.5 472 461.5 420.7 424.6C326.8 357.2 382.1 259.5 523 244.1C535.9 242.7 588.4 243.6 601 245.4Z"/><linearGradient id="ut-core" x1="0" y1="397" x2="0" y2="631" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff4ac0"/><stop offset="0.1" stop-color="#ff45c3"/><stop offset="0.2" stop-color="#ff46c0"/><stop offset="0.3" stop-color="#a141ff"/><stop offset="0.4" stop-color="#703cff"/><stop offset="0.5" stop-color="#5243ff"/><stop offset="0.6" stop-color="#3164ff"/><stop offset="0.7" stop-color="#0e8aff"/><stop offset="0.8" stop-color="#00b5ff"/><stop offset="0.9" stop-color="#00eeff"/><stop offset="1" stop-color="#4ffff7"/></linearGradient><radialGradient id="ut-fade" cx="502" cy="539" r="112" gradientUnits="userSpaceOnUse" gradientTransform="translate(502 539) rotate(50) scale(1 3.05) translate(-502 -539)"><stop offset="0" stop-color="currentColor" stop-opacity="0.0055"/><stop offset="0.0714" stop-color="currentColor" stop-opacity="0.0061"/><stop offset="0.1429" stop-color="currentColor" stop-opacity="0.0071"/><stop offset="0.2143" stop-color="currentColor" stop-opacity="0.0151"/><stop offset="0.2857" stop-color="currentColor" stop-opacity="0.0404"/><stop offset="0.3571" stop-color="currentColor" stop-opacity="0.0872"/><stop offset="0.4286" stop-color="currentColor" stop-opacity="0.164"/><stop offset="0.5" stop-color="currentColor" stop-opacity="0.25"/><stop offset="0.5714" stop-color="currentColor" stop-opacity="0.3639"/><stop offset="0.6429" stop-color="currentColor" stop-opacity="0.5495"/><stop offset="0.7143" stop-color="currentColor" stop-opacity="0.7111"/><stop offset="0.7857" stop-color="currentColor" stop-opacity="0.8253"/><stop offset="0.8571" stop-color="currentColor" stop-opacity="0.9155"/><stop offset="0.9286" stop-color="currentColor" stop-opacity="0.9739"/><stop offset="1" stop-color="currentColor" stop-opacity="0.9885"/></radialGradient></defs><use href="#ut-mark" fill="url(#ut-core)"/><use href="#ut-mark" fill="url(#ut-fade)"/></svg>`;

/**
 * Runs in the main window before the "before" picture: everything that
 * animates on its own pauses and the caret hides, so the two pictures differ
 * only where the change did. Elements marked `data-update-transition="live"`
 * (the Update card's progress) keep running and stay out of the comparison;
 * their rects come back in CSS px, with whether the page is on screen at all.
 */
const FREEZE_SCRIPT = `(() => {
  const isLive = (node) => Boolean(node && node.closest && node.closest('[data-update-transition="live"]'));
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { caret-color: transparent !important; }";
  document.head.append(style);
  const paused = document.getAnimations().filter((a) => a.playState === "running" && !isLive(a.effect && a.effect.target));
  for (const a of paused) a.pause();
  window.__stellaUpdateThaw = () => {
    style.remove();
    for (const a of paused) if (a.playState === "paused") a.play();
    delete window.__stellaUpdateThaw;
  };
  return {
    visible: document.visibilityState === "visible",
    live: [...document.querySelectorAll('[data-update-transition="live"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return [Math.floor(r.left) - 2, Math.floor(r.top) - 2, Math.ceil(r.width) + 4, Math.ceil(r.height) + 4];
    }),
  };
})()`;

const THAW_SCRIPT = "window.__stellaUpdateThaw?.()";

/** Two frames: whatever the last change rendered is now on screen. */
const PAINTED_SCRIPT =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

/** Live: the page finished loading and its launch splash is gone. */
const LIVE_SCRIPT =
  'document.readyState === "complete" && !document.getElementById("stella-launch")';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class UpdateTransition {
  private readonly options: UpdateTransitionOptions;
  private view: WebContentsView | null = null;
  private viewLoad: Promise<void> | null = null;

  constructor(options: UpdateTransitionOptions) {
    this.options = options;
  }

  /** Load the overlay ahead of time while an update waits, so a click doesn't pay for it. */
  prewarm() {
    if (!this.view || this.view.webContents.isDestroyed()) this.createView();
  }

  /**
   * Picture the window and cover it with that picture. Null when there is
   * nothing to cover (no visible window) or covering failed; the swap then
   * runs plain. Covering can start before the swap is ready to run (main
   * starts it while the launcher signs the change): nothing on screen moves
   * in between.
   */
  async cover(): Promise<CoveredWindow | null> {
    const win = this.visibleWindow();
    if (!win) return null;
    const started = performance.now();
    let view: WebContentsView;
    let before: NativeImage;
    let live: LiveRect[];
    try {
      const frozen = await this.freeze(win);
      if (!frozen) {
        await win.webContents.executeJavaScript(THAW_SCRIPT).catch(() => {});
        return null;
      }
      live = frozen;
      view = await this.attach(win);
      before = await this.capture(win);
      await this.call(view, "cover", jpegUrl(before), live);
    } catch (error) {
      this.fail("cover", error);
      await this.uncover(win);
      return null;
    }
    const coverMs = Math.round(performance.now() - started);
    return {
      cancel: () => this.uncover(win),
      reveal: async <T>(swap: () => Promise<T>) => {
        // A swap the page can't take hot reloads it: what was live under the
        // cover goes, so the cover shows it pictured instead.
        let reloaded = false;
        const reloading = () => {
          reloaded = true;
          void this.call(view, "fillLive").catch(() => {});
        };
        win.webContents.once("did-start-loading", reloading);
        const swapStarted = performance.now();
        let result: T;
        let small: ReturnType<typeof quarter>;
        try {
          const swapping = swap();
          // Off the critical path: the swap is mostly waiting on the renderer.
          small = quarter(before);
          result = await swapping;
        } catch (error) {
          await this.uncover(win);
          throw error;
        } finally {
          win.webContents.removeListener("did-start-loading", reloading);
        }
        try {
          const swapped = performance.now();
          await this.waitUntilShown(win, { reloaded: () => reloaded });
          const shown = performance.now();
          const after = await this.capture(win);
          const capturedAt = performance.now();
          const { width: vw, height: vh } = win.getContentBounds();
          const dpr = after.getSize().width / vw;
          const next = quarter(after);
          const quarteredAt = performance.now();
          const sameSize = next.w === small.w && next.h === small.h;
          const { whole, regions } = sameSize
            ? diffRegions(small.pixels, next.pixels, next.w, next.h, 4 / dpr, { w: vw, h: vh }, live)
            : { whole: true, regions: [{ x: 0, y: 0, w: vw, h: vh }] };
          const diffedAt = performance.now();
          const items = regions.map((region): RevealItem => {
            const rect = whole ? region : grow(region, FEATHER, vw, vh);
            const crop = whole
              ? after
              : after.crop({
                  x: Math.round(rect.x * dpr),
                  y: Math.round(rect.y * dpr),
                  width: Math.round(rect.w * dpr),
                  height: Math.round(rect.h * dpr),
                });
            return { rect, feather: whole ? [0, 0, 0, 0] : edges(rect, FEATHER, vw, vh), after: jpegUrl(crop) };
          });
          const compared = performance.now();
          const report = items.length
            ? ((await this.call(view, "reveal", items, whole, focusPull())) as RevealReport)
            : null;
          this.options.log("app-source.transition", {
            coverMs,
            swapMs: Math.round(swapped - swapStarted),
            paintMs: Math.round(shown - swapped),
            compareMs: Math.round(compared - shown),
            split: `capture ${Math.round(capturedAt - shown)} quarter ${Math.round(quarteredAt - capturedAt)} diff ${Math.round(diffedAt - quarteredAt)} crops ${Math.round(compared - diffedAt)}`,
            prepMs: report?.prepMs ?? 0,
            regions: regions.length,
            whole,
            rects: regions.map((r) => `${r.x},${r.y} ${r.w}x${r.h}`).join(" | "),
            totalMs: Math.round(performance.now() - started),
          });
        } catch (error) {
          this.fail("reveal", error);
        } finally {
          await this.uncover(win);
        }
        return result;
      },
    };
  }

  /**
   * Before a relaunch: frost the window, keep the frosted frame for the
   * launcher and the next process, and start the label. Never throws.
   */
  async holdForRelaunch(): Promise<void> {
    const win = this.visibleWindow();
    if (!win) return;
    const since = Date.now();
    try {
      if (!(await this.freeze(win))) return;
      const view = await this.attach(win);
      const before = await this.capture(win);
      await this.call(view, "cover", jpegUrl(before), []);
      const { frosted, dark } = (await this.call(view, "frost", frost())) as {
        frosted: string;
        dark: boolean;
      };
      const mark = (await this.call(view, "renderMark", MARK_SVG, dark, HOLD_MARK_PX)) as string;
      const hold: UpdateHold = {
        image: path.join(this.options.holdDir, HOLD_IMAGE),
        mark: path.join(this.options.holdDir, HOLD_MARK),
        label: this.options.holdLabel(),
        since,
        dark,
        frame: win.getContentBounds(),
      };
      await fs.mkdir(this.options.holdDir, { recursive: true });
      await fs.writeFile(hold.image, Buffer.from(frosted, "base64"));
      await fs.writeFile(hold.mark, Buffer.from(mark, "base64"));
      await fs.writeFile(path.join(this.options.holdDir, HOLD_RECORD), JSON.stringify(hold));
      this.options.onHold?.(hold);
      // The old window keeps holding until the process exits.
      void this.call(view, "hold", `data:image/jpeg;base64,${frosted}`, this.holdOptions(hold)).catch(() => {});
    } catch (error) {
      this.fail("hold", error);
    }
  }

  /** A restart left a hold for this process (cheap, synchronous). */
  hasPendingHold() {
    return existsSync(path.join(this.options.holdDir, HOLD_RECORD));
  }

  /**
   * In the process after a relaunch, with the main window just created and
   * not yet shown: if a fresh hold is waiting, show it over the window.
   * Returns once the hold is on screen (or there is none); the focus-in runs
   * on its own once the window is live.
   */
  async resumeAfterRelaunch(win: BrowserWindow): Promise<void> {
    const record = path.join(this.options.holdDir, HOLD_RECORD);
    const hold = await fs
      .readFile(record, "utf8")
      .then((text) => JSON.parse(text) as UpdateHold)
      .catch(() => null);
    await fs.rm(record, { force: true });
    if (!hold || Date.now() - hold.since > HOLD_MAX_AGE_MS) return;
    let view: WebContentsView;
    try {
      const image = await fs.readFile(hold.image);
      view = await this.attach(win);
      await this.call(view, "hold", `data:image/jpeg;base64,${image.toString("base64")}`, this.holdOptions(hold));
    } catch (error) {
      this.fail("resume-hold", error);
      await this.uncover(win);
      return;
    }
    void (async () => {
      try {
        await this.waitUntilShown(win, { reloaded: () => true });
        const after = await this.capture(win);
        await this.call(view, "focusIn", jpegUrl(after), focusIn());
        this.options.log("app-source.relaunch-transition", {
          heldMs: Date.now() - hold.since,
        });
      } catch (error) {
        this.fail("focus-in", error);
      } finally {
        await this.uncover(win);
        await fs.rm(hold.image, { force: true });
        await fs.rm(hold.mark, { force: true });
      }
    })();
  }

  private holdOptions(hold: UpdateHold): HoldOptions {
    return {
      labelDelayMs: hold.since + LABEL_DELAY_MS - Date.now(),
      dark: hold.dark,
      label: this.options.holdLabel(),
      markSvg: MARK_SVG,
      appear: appear(),
    };
  }

  private visibleWindow() {
    const win = this.options.getWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
    return win;
  }

  /** The overlay, on top of `win`'s views, sized to it, loaded and visible. */
  private createView() {
    const view = new WebContentsView({
      webPreferences: {
        partition: this.options.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor("#00000000");
    this.view = view;
    this.viewLoad = view.webContents.loadURL(TRANSITION_PAGE_URL);
    return view;
  }

  private async attach(win: BrowserWindow): Promise<WebContentsView> {
    const view =
      this.view && !this.view.webContents.isDestroyed() ? this.view : this.createView();
    await timeout(this.viewLoad!, STEP_TIMEOUT_MS, "Loading the transition page");
    // Adding a child that is already there moves it to the top.
    win.contentView.addChildView(view);
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
    view.setVisible(true);
    return view;
  }

  private async uncover(win: BrowserWindow) {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    await view.webContents.executeJavaScript("window.__updateTransition?.clear()").catch(() => {});
    view.setVisible(false);
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(view);
      await win.webContents.executeJavaScript(THAW_SCRIPT).catch(() => {});
    }
  }

  /**
   * Freeze the window for its pictures. Null when its page isn't on screen
   * (covered, on another space, the display asleep): it paints no frames then,
   * and nobody would see a transition anyway.
   */
  private async freeze(win: BrowserWindow): Promise<LiveRect[] | null> {
    const { visible, live } = (await timeout(
      win.webContents.executeJavaScript(FREEZE_SCRIPT),
      STEP_TIMEOUT_MS,
      "Freezing the window",
    )) as { visible: boolean; live: LiveRect[] };
    if (!visible) return null;
    const zoom = win.webContents.getZoomFactor();
    return live.map(([x, y, w, h]) => [x * zoom, y * zoom, w * zoom, h * zoom]);
  }

  /** A picture of the window; bounded, since a window that stops painting never answers. */
  private capture(win: BrowserWindow) {
    return timeout(win.webContents.capturePage(), CAPTURE_TIMEOUT_MS, "Capturing the window");
  }

  /**
   * Until what the swap rendered is on screen: two frames after a hot
   * update; after a reload (or in a fresh process), until the page is live
   * again and has painted.
   */
  private async waitUntilShown(win: BrowserWindow, { reloaded }: { reloaded: () => boolean }) {
    const contents = win.webContents;
    if (!reloaded() && !contents.isLoading()) {
      const painted = await timeout(contents.executeJavaScript(PAINTED_SCRIPT), 1_000, "Waiting for paint")
        .then(() => true, () => false);
      if (painted && !reloaded() && !contents.isLoading()) return;
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const isLive = await timeout(
        contents.executeJavaScript(LIVE_SCRIPT) as Promise<boolean>,
        1_000,
        "Checking the window",
      ).catch(() => false);
      if (isLive) break;
      await delay(60);
    }
    // A page that stops painting (covered mid-swap) never answers; go on.
    await timeout(contents.executeJavaScript(PAINTED_SCRIPT), 1_000, "Waiting for paint").catch(() => {});
  }

  private call(view: WebContentsView, method: string, ...args: unknown[]) {
    const script = `window.__updateTransition.${method}(...${JSON.stringify(args)})`;
    return timeout(view.webContents.executeJavaScript(script), STEP_TIMEOUT_MS, `Transition ${method}`);
  }

  private fail(step: string, error: unknown) {
    this.options.log("app-source.transition-failed", {
      step,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
