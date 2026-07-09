import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const BASE_URL = process.env.STELLA_SCREENSHOT_URL ?? "http://localhost:3000";
const OUTPUT_ROOT = path.resolve(
  process.cwd(),
  process.env.STELLA_SCREENSHOT_OUTPUT ??
    "../mobile/store/apple/screenshot/en-US",
);

const slides = ["hero", "chat", "tasks", "pairing", "privacy", "settings"];
const devices = [
  {
    query: "iphone",
    group: "APP_IPHONE_65",
    canvas: { width: 1290, height: 2796 },
    output: { width: 1242, height: 2688 },
  },
  {
    query: "ipad",
    group: "APP_IPAD_PRO_3GEN_129",
    canvas: { width: 2064, height: 2752 },
    output: { width: 2064, height: 2752 },
  },
] as const;

async function clearPngs(directory: string) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
      .map((entry) => unlink(path.join(directory, entry.name))),
  );
}

async function prepareSlide(
  page: Page,
  slug: string,
  canvas: { width: number; height: number },
  output: { width: number; height: number },
) {
  await page.evaluate(
    ({ requestedSlug, canvasSize, outputSize }) => {
      document.querySelectorAll("nextjs-portal").forEach((node) => node.remove());
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-export-slide]"),
      );
      for (const node of nodes) {
        const active = node.dataset.exportSlide === requestedSlug;
        node.style.position = "fixed";
        node.style.left = active ? "0" : "-99999px";
        node.style.top = "0";
        node.style.zIndex = active ? "99999" : "-1";
        node.style.opacity = active ? "1" : "0";
        node.style.width = `${outputSize.width}px`;
        node.style.height = `${outputSize.height}px`;
        node.style.overflow = "hidden";
        node.style.pointerEvents = "none";

        const slide = node.firstElementChild as HTMLElement | null;
        if (slide) {
          slide.style.transformOrigin = "top left";
          slide.style.transform = `scale(${outputSize.width / canvasSize.width}, ${outputSize.height / canvasSize.height})`;
        }
      }
      document.body.style.margin = "0";
      document.body.style.overflow = "hidden";
    },
    { requestedSlug: slug, canvasSize: canvas, outputSize: output },
  );
}

const browser = await chromium.launch({ headless: true });

try {
  for (const device of devices) {
    const directory = path.join(OUTPUT_ROOT, device.group);
    await clearPngs(directory);

    const page = await browser.newPage({
      viewport: {
        width: Math.max(device.canvas.width, device.output.width),
        height: Math.max(device.canvas.height, device.output.height),
      },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });

    await page.goto(`${BASE_URL}/?theme=carbon&device=${device.query}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector('[data-export-slide="hero"]', {
      state: "attached",
    });
    await page.evaluate(async () => await document.fonts.ready);

    for (const [index, slug] of slides.entries()) {
      await prepareSlide(page, slug, device.canvas, device.output);
      const target = page.locator(`[data-export-slide="${slug}"]`);
      const filename = `${index + 1}-${slug}.png`;
      await target.screenshot({
        path: path.join(directory, filename),
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      console.log(`${device.group}/${filename}`);
    }

    await page.close();
  }
} finally {
  await browser.close();
}
