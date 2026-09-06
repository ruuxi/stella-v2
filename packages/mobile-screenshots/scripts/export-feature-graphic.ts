import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.STELLA_SCREENSHOT_URL ?? "http://localhost:3000";
const output = path.resolve(
  process.env.STELLA_FEATURE_GRAPHIC_OUTPUT ??
    `out/feature-graphic-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const sources = await Promise.all(
  [
    "public/supporting/computer.png",
    "public/captures/android/computer.png",
  ].map(async (source) => {
    const bytes = await readFile(source);
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw new Error(`Invalid PNG: ${source}`);
    return {
      source,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
await mkdir(output, { recursive: false });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.STELLA_SCREENSHOT_BROWSER_CHANNEL,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 500 },
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}/feature-graphic`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
      const auras = [...document.querySelectorAll('[data-aura-ready]')];
      return auras.length > 0 && auras.every(aura => aura.getAttribute('data-aura-ready') === 'true');
    });
    await page.waitForFunction(() => {
      const marks = [...document.querySelectorAll('[data-brand-ready]')];
      return marks.length > 0 && marks.every((mark) => mark.getAttribute('data-brand-ready') === 'true');
    });
  const target = page.locator("[data-export-feature-graphic]");
  if (
    (await target.getAttribute("data-output-ready")) !== "true" ||
    (await target.getAttribute("data-native-ready")) !== "true"
  )
    throw new Error(
      "Actual output and Android UI are required; restart studio after adding sources.",
    );
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [
        ...document.querySelectorAll<HTMLImageElement>("[data-feature-source]"),
      ].map((image) => image.decode()),
    );
  });
  const bytes = await target.screenshot({
    path: path.join(output, "feature-graphic.png"),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  if (bytes.readUInt32BE(16) !== 1024 || bytes.readUInt32BE(20) !== 500)
    throw new Error("Incorrect feature graphic dimensions");
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: "review-required",
        sources,
        exports: [
          {
            file: "feature-graphic.png",
            width: 1024,
            height: 500,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Review feature graphic and provenance: ${output}`);
} finally {
  await browser.close();
}
