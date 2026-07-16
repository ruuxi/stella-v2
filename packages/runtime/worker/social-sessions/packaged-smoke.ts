import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SocialPreviewServerManager } from "./preview-server.js";
import { ensureSocialWorkspaceTemplate } from "./template.js";

const workspacePath = await mkdtemp(
  path.join(os.tmpdir(), "stella-packaged-social-"),
);
const manager = new SocialPreviewServerManager();

try {
  await ensureSocialWorkspaceTemplate(workspacePath);
  const url = await manager.ensureStarted("packaged-smoke", workspacePath);
  if (!url) {
    throw new Error("Social-session Vite preview did not report a URL.");
  }
  const response = await fetch(url);
  const html = await response.text();
  if (!response.ok || !html.includes("/src/main.tsx")) {
    throw new Error(
      `Social-session preview returned an unexpected response (${response.status}).`,
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      bun: process.execPath,
      url,
      workspacePath,
    }),
  );
} finally {
  await manager.shutdown();
  await rm(workspacePath, { recursive: true, force: true });
}
