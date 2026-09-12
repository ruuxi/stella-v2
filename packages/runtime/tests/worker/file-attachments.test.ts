import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeFileAttachments, MAX_FILE_ATTACHMENT_BYTES } from "@stella/runtime/worker/server/attachments";
import { createUserPromptMessage, createRuntimePromptAgentMessage, createFileAttachmentPromptInput } from "@stella/runtime/kernel/agent-runtime/run-preparation";
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
