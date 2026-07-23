import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const [distArg, prefixArg] = process.argv.slice(2);
if (!distArg || !prefixArg) {
  throw new Error("Usage: publish-interior.mjs <dist-dir> <artifact-prefix>");
}

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const dist = path.resolve(distArg);
if (!(await stat(dist)).isDirectory())
  throw new Error("Dist directory not found.");

const files = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile()) files.push(absolute);
  }
};
await walk(dist);

const contentType = (file) => {
  const extension = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
      ".mjs": "text/javascript; charset=utf-8",
      ".wasm": "application/wasm",
    }[extension] ?? "application/octet-stream"
  );
};

const client = new S3Client({
  region: "auto",
  endpoint: required("R2_ENDPOINT"),
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});
const bucket = required("R2_BUCKET");
let uploadedBytes = 0;
const pending = [...files];
await Promise.all(
  Array.from({ length: Math.min(12, files.length) }, async () => {
    while (pending.length) {
      const absolute = pending.pop();
      if (!absolute) return;
      const body = await readFile(absolute);
      const relative = path.relative(dist, absolute).split(path.sep).join("/");
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefixArg.replace(/\/+$/, "")}/${relative}`,
          Body: body,
          ContentType: contentType(relative),
          CacheControl:
            relative === "index.html"
              ? "no-cache"
              : "public, max-age=31536000, immutable",
        }),
      );
      uploadedBytes += body.byteLength;
    }
  }),
);

process.stdout.write(
  `${JSON.stringify({ prefix: prefixArg, files: files.length, uploadedBytes })}\n`,
);
