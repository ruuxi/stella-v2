/**
 * Publish a built renderer as a new immutable interior version.
 *
 * Usage:
 *   node scripts/publish-interior.mjs <distDir> <artifactPrefix>
 *
 * Requires R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in the
 * environment (pipe them from the Convex deployment; never print them) and an
 * existing `<distDir>/../interior-bundle.zip` alongside, produced by zipping
 * the dist contents. Uploads every file plus bundle.zip under the prefix in
 * the dev app-builds bucket, then prints the KV record to store at
 * `app:stella-interior`. Never reuses an existing prefix.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const [distDir, prefix] = process.argv.slice(2);
if (!distDir || !prefix) {
  console.error("Usage: publish-interior.mjs <distDir> <artifactPrefix>");
  process.exit(1);
}

const BUCKET = process.env.INTERIOR_BUCKET ?? "stella-v2-app-builds-dev";
const client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".zip", "application/zip"],
  [".webmanifest", "application/manifest+json"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

const listFiles = async (dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
};

const files = await listFiles(distDir);
const bundlePath = path.join(path.dirname(distDir), "interior-bundle.zip");
const uploads = files.map((file) => ({
  key: `${prefix}/${path.relative(distDir, file).split(path.sep).join("/")}`,
  file,
}));
try {
  await stat(bundlePath);
  uploads.push({ key: `${prefix}/bundle.zip`, file: bundlePath });
} catch {
  console.error("No interior-bundle.zip found; publishing files only.");
}

let done = 0;
const queue = [...uploads];
const worker = async () => {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    const body = await readFile(item.file);
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: item.key,
        Body: body,
        ContentType:
          contentTypes.get(path.extname(item.file).toLowerCase()) ??
          "application/octet-stream",
        CacheControl: item.key.endsWith("index.html")
          ? "no-store"
          : "public, max-age=31536000, immutable",
      }),
    );
    done += 1;
  }
};
await Promise.all(Array.from({ length: 8 }, worker));
console.log(
  JSON.stringify({
    uploaded: done,
    prefix,
    kvRecord: { artifactPrefix: prefix, suspended: false },
  }),
);
