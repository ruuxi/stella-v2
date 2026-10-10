import path from "node:path";
import fs, { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractAttachImageBlocks,
  extractCodeImageBlocks,
  neutralizeLegacyAttachImageMarkers,
  prepareAuthorizedToolImageBlocks,
  truncateModelVisibleToolText,
} from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import { MAX_IMAGE_BASE64_BYTES } from "@stella/runtime/kernel/shared/image-payload";
import { createSyncTempDirTracker } from "../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const createTempDir = () => {
  return tempDirs.create("stella-attach-image-");
};

// 1x1 transparent PNG (smallest valid PNG bytes).
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff,
  0xd9,
]);

const writePng = (dir: string, name = "snap.png") => {
  const outPath = path.join(dir, name);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, ONE_BY_ONE_PNG);
  return outPath;
};

describe("extractAttachImageBlocks (stella-computer auto-read)", () => {
  it("extracts a single PNG referenced by a [stella-attach-image] marker", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);

    const text = `<app_state>
App=com.apple.finder (pid 504)
0 menu bar
</app_state>
[stella-attach-image] 1x1 1KB inline=image/png ${imgPath}
`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    // Marker should be stripped from forwarded text.
    expect(result.text).not.toContain("[stella-attach-image]");
    expect(result.text).toContain("App=com.apple.finder");
  });

  it("extracts an image from a detail=original marker and strips it", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);

    const text = `[stella-attach-image] inline=image/png detail=original ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text, {
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    // The detail token and marker are both stripped from forwarded text.
    expect(result.text).not.toContain("[stella-attach-image]");
    expect(result.text).not.toContain("detail=original");
  });

  it("accepts a provider target without altering a small pass-through image", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);

    const text = `[stella-attach-image] inline=image/png ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text, { provider: "openai" });
    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
  });

  it("uses image bytes over marker and extension when MIME types disagree", async () => {
    const tempDir = createTempDir();
    const imgPath = path.join(tempDir, "term-shot.png");
    writeFileSync(imgPath, JPEG_BYTES);

    const text = `[stella-attach-image] 2728x1872 43KB inline=image/png ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/jpeg");
    expect(result.images[0].data).toBe(JPEG_BYTES.toString("base64"));
  });

  it("falls back to the raw text when the referenced file is missing", async () => {
    const text =
      "<app_state>...</app_state>\n" +
      "[stella-attach-image] 1x1 1KB inline=image/png /tmp/does-not-exist-zzzz.png\n";
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("[stella-attach-image]");
  });

  it("ignores markers that don't point at an image file", async () => {
    const text =
      "[stella-attach-image] 1x1 1KB inline=image/png /tmp/notes.txt\n";
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toBe(text);
  });

  it("omits (rather than attaches) a file whose bytes are not a valid image", async () => {
    // Bytes that no image decoder can process (e.g. a corrupt/partial
    // capture). Attaching them raw would 400 Anthropic fatally and poison
    // the thread on every resume, so the marker is swapped for a note.
    const tempDir = createTempDir();
    const jpgPath = path.join(tempDir, "snap.jpg");
    writeFileSync(jpgPath, Buffer.from("not-enough-image-bytes"));
    const text = `[stella-attach-image] 100x100 inline=image/jpeg ${jpgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("could not be decoded");
    expect(result.text).not.toContain("[stella-attach-image]");
  });

  it("omits a truncated PNG whose header parses but stream is incomplete", async () => {
    // The exact reproduction shape: valid PNG signature + IHDR, but the
    // stream is cut off before IEND (a screenshot read mid-write).
    const tempDir = createTempDir();
    const imgPath = path.join(tempDir, "truncated.png");
    writeFileSync(
      imgPath,
      ONE_BY_ONE_PNG.subarray(0, ONE_BY_ONE_PNG.length - 16),
    );
    const text = `[stella-attach-image] 1x1 inline=image/png ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("could not be decoded");
  });

  it("extracts JSON-escaped Windows image paths", async () => {
    const tempDir = createTempDir();
    const previousCwd = process.cwd();
    const winPath = "C:\\Users\\test\\stella-snap.png";
    try {
      process.chdir(tempDir);
      writePng(tempDir, winPath);
      const text =
        "[stella-attach-image] 100x100 inline=image/png C:\\\\Users\\\\test\\\\stella-snap.png\n";
      const result = await extractAttachImageBlocks(text);
      expect(result.images).toHaveLength(1);
      expect(result.images[0].mimeType).toBe("image/png");
      expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
      expect(result.text).not.toContain("[stella-attach-image]");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("extracts quoted path= markers with spaces, quotes, non-ASCII, and JSON escaping", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir, 'capture "café" final.png');
    const marker = `[stella-attach-image] inline=image/png path=${JSON.stringify(imgPath)}`;
    const result = await extractAttachImageBlocks(
      JSON.stringify({ output: `visible tree\n${marker}\n` }, null, 2),
    );

    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    expect(result.text).toContain("visible tree");
    expect(result.text).not.toContain("[stella-attach-image]");
  });

  it("extracts a quoted absolute Windows path containing spaces and non-ASCII", async () => {
    const tempDir = createTempDir();
    const previousCwd = process.cwd();
    const winPath = 'C:\\Users\\René Test\\screen "final".png';
    try {
      process.chdir(tempDir);
      writePng(tempDir, winPath);
      const result = await extractAttachImageBlocks(
        `[stella-attach-image] inline=image/png path=${JSON.stringify(winPath)}\n`,
      );
      expect(result.images).toHaveLength(1);
      expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
      expect(result.text).not.toContain("[stella-attach-image]");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("keeps valid sibling images when one referenced image is missing", async () => {
    const tempDir = createTempDir();
    const firstPath = writePng(tempDir, "first valid.png");
    const secondPath = writePng(tempDir, "second valid.png");
    const missingPath = path.join(tempDir, "missing image.png");
    const text = [firstPath, missingPath, secondPath]
      .map(
        (imagePath) =>
          `[stella-attach-image] inline=image/png path=${JSON.stringify(imagePath)}`,
      )
      .join("\n");

    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(2);
    expect(result.images.map((image) => image.data)).toEqual([
      ONE_BY_ONE_PNG.toString("base64"),
      ONE_BY_ONE_PNG.toString("base64"),
    ]);
    expect(result.text).toContain(missingPath);
    expect(result.text.match(/\[stella-attach-image\]/g)).toHaveLength(1);
  });

  it("auto-resizes oversized images and notes the coordinate mapping (pi parity)", async () => {
    // Pi-style attach behavior: a too-large image is resized to fit the
    // vision budget instead of being bounced back with a "go downscale it
    // yourself" note, and the model gets a dimension note for coordinate
    // mapping. Generate a real >2000px noise PNG via Photon so the resize
    // path actually exercises decode → resize → encode.
    const photon = await import("@silvia-odwyer/photon-node");
    const size = 2400;
    const raw = new Uint8Array(size * size * 4);
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = (i * 31) % 256;
      raw[i + 1] = (i * 17) % 256;
      raw[i + 2] = (i * 7) % 256;
      raw[i + 3] = 255;
    }
    const bigImage = new photon.PhotonImage(raw, size, size);
    const bigPngBytes = Buffer.from(bigImage.get_bytes());
    bigImage.free();

    const tempDir = createTempDir();
    const bigPath = path.join(tempDir, "huge.png");
    writeFileSync(bigPath, bigPngBytes);
    const smallPath = writePng(tempDir, "small.png");

    const text =
      `[stella-attach-image] inline=image/png ${bigPath}\n` +
      `[stella-attach-image] inline=image/png ${smallPath}\n`;
    const result = await extractAttachImageBlocks(text);

    // Both images attach: the big one resized, the small one untouched.
    expect(result.images).toHaveLength(2);
    expect(result.images[0].data.length).toBeLessThan(
      bigPngBytes.toString("base64").length,
    );
    expect(result.images[1].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    // Dimension note for the resized image only; markers stripped.
    expect(result.text).toContain(`original ${size}x${size}`);
    expect(result.text).toContain("Multiply coordinates by");
    expect(result.text).not.toContain("[stella-attach-image]");
  }, 15_000);

  it("gates the raw-attach fallback on the shared Anthropic per-image ceiling", () => {
    // The attach gate and the Anthropic send boundary must enforce the SAME
    // base64 ceiling (a single shared constant): otherwise an oversized image
    // can pass the gate here and then be silently dropped to "[Image omitted]"
    // at the wire. tool-adapters imports MAX_IMAGE_BASE64_BYTES from
    // image-payload, which sources the value from image-caps (the direct-API
    // 10MB cap), so the two can't drift apart.
    expect(MAX_IMAGE_BASE64_BYTES).toBe(10 * 1024 * 1024);
  });

  it("passes small images through byte-identical (no resize, no note)", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);
    const text = `[stella-attach-image] 1x1 1KB inline=image/png ${imgPath}\n`;
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    expect(result.text).not.toContain("Multiply coordinates by");
  });

  it("extracts a marker embedded inside a JSON-stringified tool result", async () => {
    // Mirrors the Bash tool result shape: stdout is wrapped inside
    // a JSON envelope where real newlines become escaped `\n` characters.
    // Before the regex fix, the start-of-line anchor meant the marker was
    // never matched in this shape and the model had to call view_image
    // separately (which then failed for >2MB screenshots).
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir);
    const payload = {
      session_id: null,
      running: false,
      exit_code: 0,
      output:
        "<app_state>\nApp=com.spotify.client (pid 465)\n0 standard window Spotify Premium\n14 menu bar\n</app_state>\n" +
        `[stella-attach-image] 2192x1688 507KB inline=image/png ${imgPath}\n`,
      cwd: "/Users/test/projects/stella",
      command: "stella-computer snapshot --app Spotify",
    };
    const text = JSON.stringify(payload, null, 2);
    const result = await extractAttachImageBlocks(text);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    expect(result.text).not.toContain("[stella-attach-image]");
  });
});

describe("descriptor-authorized cloud images", () => {
  it("neutralizes raw and JSON-wrapped legacy markers without exposing their paths", () => {
    const privatePath = "/home/stella-native-state/anthropic/private.png";
    const raw = neutralizeLegacyAttachImageMarkers(
      `visible tree\n[stella-attach-image] inline=image/png path=${JSON.stringify(privatePath)}\nafter`,
    );
    expect(raw).toContain("visible tree");
    expect(raw).toContain("descriptor-authorized image bytes");
    expect(raw).toContain("after");
    expect(raw).not.toContain("[stella-attach-image]");
    expect(raw).not.toContain(privatePath);

    const wrapped = neutralizeLegacyAttachImageMarkers(
      JSON.stringify({
        output: `[stella-attach-image] inline=image/png ${privatePath}\n`,
      }),
    );
    expect(wrapped).toContain("descriptor-authorized image bytes");
    expect(wrapped).not.toContain("[stella-attach-image]");
    expect(wrapped).not.toContain(privatePath);
  });

  it("materializes already-authorized bytes without reopening sourcePath", async () => {
    const missingPath = "/definitely/missing/authorized-image.png";
    const images = await prepareAuthorizedToolImageBlocks(
      [
        {
          data: ONE_BY_ONE_PNG,
          mimeType: "image/png",
          sourcePath: missingPath,
        },
      ],
      { provider: "anthropic", modelId: "claude-opus-4-8" },
    );

    expect(existsSync(missingPath)).toBe(false);
    expect(images).toEqual([
      {
        type: "image",
        data: ONE_BY_ONE_PNG.toString("base64"),
        mimeType: "image/png",
        sourcePath: missingPath,
        width: 1,
        height: 1,
      },
    ]);
  });

  it("applies the resolved provider dimension cap to authorized bytes", async () => {
    const photon = await import("@silvia-odwyer/photon-node");
    const width = 2_100;
    const raw = new Uint8Array(width * 4);
    for (let index = 0; index < width; index += 1) {
      raw[index * 4] = index % 256;
      raw[index * 4 + 1] = (index * 3) % 256;
      raw[index * 4 + 2] = (index * 7) % 256;
      raw[index * 4 + 3] = 255;
    }
    const source = new photon.PhotonImage(raw, width, 1);
    const bytes = Buffer.from(source.get_bytes());
    source.free();

    const images = await prepareAuthorizedToolImageBlocks(
      [{ data: bytes, mimeType: "image/png", sourcePath: "/missing/wide.png" }],
      { provider: "anthropic", modelId: "claude-3-5-sonnet" },
    );

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      type: "image",
      width: 1_568,
      height: 1,
    });
    expect(images[0]!.data.length).toBeLessThan(10 * 1024 * 1024);
  });

  it("rejects typed bytes whose declared MIME does not match their content", async () => {
    const images = await prepareAuthorizedToolImageBlocks([
      {
        data: ONE_BY_ONE_PNG,
        mimeType: "image/jpeg",
        sourcePath: "/missing/mislabeled.jpg",
      },
    ]);
    expect(images).toEqual([]);
  });
});

describe("typed code images", () => {
  it("materializes structured images without compatibility markers", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir, "typed node repl.png");
    const images = await extractCodeImageBlocks({
      code: {
        content: [
          {
            type: "image",
            path: imgPath,
            mimeType: "image/png",
            detail: "original",
          },
          {
            type: "audio",
            path: path.join(tempDir, "audio.mp3"),
            mimeType: "audio/mpeg",
          },
        ],
      },
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      sourcePath: imgPath,
    });
    expect(images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    expect(existsSync(imgPath)).toBe(true);
  });

  it("keeps legacy nodeRepl image details readable after the rename", async () => {
    const tempDir = createTempDir();
    const imgPath = writePng(tempDir, "temporary browser screenshot.png");
    const images = await extractCodeImageBlocks({
      nodeRepl: {
        content: [
          {
            type: "image",
            path: imgPath,
            mimeType: "image/png",
            deleteAfterAttach: true,
          },
        ],
      },
    });

    expect(images).toHaveLength(1);
    expect(images[0].data).toBe(ONE_BY_ONE_PNG.toString("base64"));
    expect(existsSync(imgPath)).toBe(false);
  });
});

describe("truncateModelVisibleToolText", () => {
  it("caps large tool output with a head and tail preview", () => {
    const text = `${"a".repeat(120)}\n${"b".repeat(120)}`;
    const result = truncateModelVisibleToolText(text, 120);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(text.length);
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(120);
    expect(result.text).toContain("Tool output truncated");
    expect(result.text).toContain("Total output lines: 2");
    expect(result.text.startsWith("a")).toBe(true);
    expect(result.text.endsWith("b")).toBe(true);
  });
});
