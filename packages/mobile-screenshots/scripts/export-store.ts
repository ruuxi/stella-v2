import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { devices, slides, type Device } from "../src/store/slides";
import { supportingArtifacts } from "../src/store/supporting";

const base = process.env.STELLA_SCREENSHOT_URL ?? "http://localhost:3000";
const requested = (
  process.env.STELLA_SCREENSHOT_DEVICES ?? "iphone,ipad"
).split(",");
for (const device of requested)
  if (!(device in devices)) throw new Error(`Unknown device: ${device}`);
const output = path.resolve(
  process.env.STELLA_SCREENSHOT_OUTPUT ??
    `out/store-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
// Preflight every native source before writing anything. Never replace an approved set.
const sourceManifest = [];
const supportingManifest = [];
for (const [slide, artifact] of Object.entries(supportingArtifacts)) {
  const source = path.join("public", artifact.source);
  const bytes = await readFile(source).catch(() => {
    throw new Error(`Missing actual supporting artifact: ${source}`);
  });
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error(`Invalid PNG: ${source}`);
  supportingManifest.push({
    slide,
    source,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
for (const device of requested as Device[]) {
  for (const slide of slides) {
    const source = path.join("public", "captures", device, `${slide.slug}.png`);
    const bytes = await readFile(source).catch(() => {
      throw new Error(
        `Missing actual ${device} capture: ${source}. Do not substitute mocked or another platform's UI.`,
      );
    });
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw new Error(`Invalid PNG: ${source}`);
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (width >= height)
      throw new Error(`Expected portrait native screenshot: ${source}`);
    sourceManifest.push({
      device,
      slide: slide.slug,
      source,
      width,
      height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}
await mkdir(output, { recursive: false });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.STELLA_SCREENSHOT_BROWSER_CHANNEL,
});
const exported = [];
try {
  for (const device of requested as Device[]) {
    const spec = devices[device];
    const directory = path.join(output, spec.group);
    await mkdir(directory);
    const page = await browser.newPage({
      viewport: { width: spec.width, height: spec.height },
      deviceScaleFactor: 1,
    });
    await page.goto(`${base}/?device=${device}&export=1`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [
          ...document.querySelectorAll<HTMLImageElement>(
            "[data-native-capture], [data-supporting-artifact]",
          ),
        ].map((image) => image.decode()),
      );
    });
    for (const [index, slide] of slides.entries()) {
      const target = page.locator(`[data-export-slide="${slide.slug}"]`);
      if ((await target.getAttribute("data-capture-ready")) !== "true")
        throw new Error(
          `Server missing ${device}/${slide.slug} capture; restart studio after adding sources.`,
        );
      if (
        supportingArtifacts[slide.slug] &&
        (await target.locator("[data-supporting-artifact]").count()) !== 1
      )
        throw new Error(
          `Server missing supporting artifact for ${slide.slug}; restart studio.`,
        );
      const filename = `${index + 1}-${slide.slug}.png`;
      const bytes = await target.screenshot({
        path: path.join(directory, filename),
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      exported.push({
        file: `${spec.group}/${filename}`,
        width: spec.width,
        height: spec.height,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      console.log(`${spec.group}/${filename}`);
    }
    await page.close();
  }
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: "review-required",
        sources: sourceManifest,
        supportingArtifacts: supportingManifest,
        exports: exported,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
console.log(`Review PNGs and manifest: ${output}`);
