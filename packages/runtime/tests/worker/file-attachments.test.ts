import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeFileAttachments, materializeImageAttachments, MAX_FILE_ATTACHMENT_BYTES } from "@stella/runtime/worker/server/attachments";
import { createUserPromptMessage, createRuntimePromptAgentMessage, createFileAttachmentPromptInput } from "@stella/runtime/kernel/agent-runtime/run-preparation";
import {
  approximateDataUrlBytes,
  attachPersistedImagePaths,
  buildSpilledAttachmentNotice,
  dataUrlBase64Length,
  INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES,
  MAX_INLINE_IMAGE_BASE64_BYTES,
  spillImageAttachmentsToDisk,
  type SpilledImageAttachment,
} from "@stella/runtime/worker/chat-attachment-spill";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const setup = async () => {
  const stellaDataDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "stella-file-test-"));
  dirs.push(stellaDataDirPath);
  return { stellaDataDirPath, conversationId: "conversation/../../escape" };
};
describe("local document attachments", () => {
  it("makes an authorized Drive document readable and exposes its real path in both prompt forms", async () => {
    const args = await setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret: amber-cactus")));
    const files = await materializeFileAttachments({ ...args, attachments: [{ url: "https://drive.example/signed", mimeType: "text/plain", kind: "file", name: "../../release-check.txt" }] });
    expect(files).toHaveLength(1);
    expect(files[0].sourcePath!.startsWith(path.join(args.stellaDataDirPath, "cache", "chat-attachments"))).toBe(true);
    expect(await fs.readFile(files[0].sourcePath!, "utf8")).toBe("secret: amber-cactus");
    for (const message of [createUserPromptMessage("Read the file", files), createRuntimePromptAgentMessage({ text: "Read the file", attachments: files }, 1)]) {
      expect(message.content).toEqual([{ type: "text", text: "Read the file" }]);
      expect(JSON.stringify(message.content)).not.toContain("https://drive.example");
    }
    const context = createFileAttachmentPromptInput(files)!;
    expect(context.text).toContain(files[0].sourcePath);
    expect(context).toMatchObject({ messageType: "message", display: false, uiVisibility: "hidden" });
  });
  it("supports local paths and base64 documents without treating images as files", async () => {
    const args = await setup();
    const localPath = path.join(args.stellaDataDirPath, "local.txt");
    await fs.writeFile(localPath, "local content");
    const files = await materializeFileAttachments({ ...args, attachments: [
      { url: localPath, kind: "file", mimeType: "text/plain" },
      { url: "data:text/plain;base64,SGVsbG8=", mimeType: "text/plain" },
      { url: "data:image/png;base64,AAAA", mimeType: "image/png" },
    ] });
    expect(files).toHaveLength(2);
    expect(files[0].sourcePath).toBe(localPath);
    expect(await fs.readFile(files[1].sourcePath!, "utf8")).toBe("Hello");
  });
  it("treats any composer file as a file, including image types the composer does not inline", async () => {
    const args = await setup();
    const attachments = [
      { url: "data:image/bmp;base64,Qk0=", mimeType: "image/bmp", kind: "file", name: "scan.bmp" },
      { url: "data:application/x-weird;base64,AAEC", mimeType: "application/x-weird", kind: "file", name: "thing.weird" },
    ];
    const files = await materializeFileAttachments({ ...args, attachments });
    expect(files.map((file) => file.name)).toEqual(["scan.bmp", "thing.weird"]);
    expect(await materializeImageAttachments(attachments)).toEqual([]);
  });
  it("rejects oversized streams without persisting or silently dropping the document", async () => {
    const args = await setup();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_FILE_ATTACHMENT_BYTES + 1)); }, cancel,
    }))));
    await expect(materializeFileAttachments({ ...args, attachments: [{ url: "https://drive.example/secret-token", kind: "file", name: "large.pdf" }] })).rejects.toThrow("exceeds 50 MiB");
    expect(cancel).toHaveBeenCalled();
    expect(await fs.readdir(args.stellaDataDirPath)).toEqual([]);
  });
});

/**
 * A composer image is inlined as pixels, so the turn itself can see it. These
 * cover the thing that broke instead: whether the turn is ever told a path it
 * can hand to an agent, which is the only way a delegate sees the image at
 * all. The two cases are the two sides of the inline budget, because the
 * over-budget side was accidentally the working one — big batches spill and
 * print paths, so the bug only showed up for small attachments.
 */
describe("local image attachments", () => {
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
  const pngDataUrl = `data:image/png;base64,${PNG_BASE64}`;

  /** The composer-image pipeline exactly as `startAdmittedChat` composes it. */
  const runImagePipeline = async (
    args: { stellaDataDirPath: string; conversationId: string },
    attachments: Parameters<typeof materializeImageAttachments>[0],
  ) => {
    let images = (await materializeImageAttachments(attachments)).map(
      ({ attachment }) => attachment,
    );
    let persisted: SpilledImageAttachment[] = [];
    if (images.length > 0) {
      persisted = await spillImageAttachmentsToDisk({ ...args, attachments: images });
      images = attachPersistedImagePaths(images, persisted);
    }
    const inlineBytes = images.reduce(
      (total, image) => total + approximateDataUrlBytes(image.url),
      0,
    );
    const overBudget =
      inlineBytes > INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES ||
      images.some(
        (image) => dataUrlBase64Length(image.url) > MAX_INLINE_IMAGE_BASE64_BYTES,
      );
    return overBudget
      ? { spilled: persisted, promptInput: null, images: [] }
      : { spilled: [], promptInput: createFileAttachmentPromptInput(images), images };
  };

  it("names a readable on-disk path for an under-budget image so the turn can delegate it", async () => {
    const args = await setup();
    const { images, spilled, promptInput } = await runImagePipeline(args, [
      { url: pngDataUrl, mimeType: "image/png", name: "screenshot.png" },
    ]);

    // Under budget the pixels stay inline, so nothing spills...
    expect(spilled).toEqual([]);
    expect(images[0]?.url.startsWith("data:image/")).toBe(true);
    // ...and the materialized ref keeps the identity the announcement needs.
    expect(images[0]).toMatchObject({ kind: "image", name: "screenshot.png" });

    // The regression: this was null, so a delegated agent got no path at all.
    expect(promptInput).not.toBeNull();
    const sourcePath = images[0]!.sourcePath!;
    expect(
      sourcePath.startsWith(path.join(args.stellaDataDirPath, "cache", "chat-attachments")),
    ).toBe(true);
    expect(promptInput!.text).toContain(sourcePath);
    expect(promptInput!.text).toContain("screenshot.png");
    expect(promptInput).toMatchObject({
      messageType: "message",
      display: false,
      uiVisibility: "hidden",
    });
    // The path has to be real, not merely well-formed.
    expect(Buffer.from(await fs.readFile(sourcePath)).toString("base64")).toBe(PNG_BASE64);
  });

  it("still names paths for an over-budget batch, and does not announce them twice", async () => {
    const args = await setup();
    // Already-materialized refs: crossing a 10MB budget through the resizer
    // would only be testing Photon.
    const oversized = "A".repeat(
      Math.ceil((INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES + 1024) / 3) * 4,
    );
    const images = attachPersistedImagePaths(
      [{ url: `data:image/png;base64,${oversized}`, mimeType: "image/png", kind: "image" }],
      await spillImageAttachmentsToDisk({
        ...args,
        attachments: [{ url: `data:image/png;base64,${oversized}`, mimeType: "image/png" }],
      }),
    );
    expect(
      approximateDataUrlBytes(images[0]!.url) > INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES,
    ).toBe(true);

    // Over budget the images are dropped from model input and replaced by the
    // spill notice, so the only announcement is that notice.
    const spilled = await spillImageAttachmentsToDisk({ ...args, attachments: images });
    const notice = buildSpilledAttachmentNotice(spilled);
    expect(notice).toContain(spilled[0]!.filePath);
    expect(notice).toContain("pass the file paths along in the agent prompt");
    expect(createFileAttachmentPromptInput([])).toBeNull();
  });

  it("does not announce the ambient window screenshot as a user attachment", async () => {
    const args = await setup();
    // The window capture is persisted and carries a path, but no `kind`: the
    // user never attached it.
    const [capture] = attachPersistedImagePaths(
      [{ url: pngDataUrl, mimeType: "image/png" }],
      await spillImageAttachmentsToDisk({
        ...args,
        attachments: [{ url: pngDataUrl, mimeType: "image/png" }],
      }),
    );
    expect(capture!.sourcePath).toBeTruthy();
    expect(createFileAttachmentPromptInput([capture!])).toBeNull();
  });

  it("announces an attached document and an attached image together", async () => {
    const args = await setup();
    const promptInput = createFileAttachmentPromptInput([
      { url: "/tmp/report.pdf", sourcePath: "/tmp/report.pdf", kind: "file", name: "report.pdf", mimeType: "application/pdf" },
      { url: pngDataUrl, sourcePath: "/tmp/shot.png", kind: "image", name: "shot.png", mimeType: "image/png" },
    ])!;
    expect(promptInput.text).toContain("The user attached a file:");
    expect(promptInput.text).toContain("The user attached an image:");
    expect(promptInput.text).toContain("/tmp/report.pdf");
    expect(promptInput.text).toContain("/tmp/shot.png");
  });
});

