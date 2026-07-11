import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { STELLA_PROMPT_IDS } from "../convex/stella_prompt_contract";
import { publishStellaPromptsRequest } from "./lib/publish-stella-prompts-request";

const root = path.resolve(import.meta.dirname, "..");
const rawSiteUrl = (
  process.env.STELLA_CONVEX_SITE_URL ??
  process.env.CONVEX_SITE_URL ??
  ""
).trim();
const token = (process.env.STELLA_ADMIN_API_SECRET ?? "").trim();
if (!rawSiteUrl || !token) {
  throw new Error("Set STELLA_CONVEX_SITE_URL and STELLA_ADMIN_API_SECRET.");
}

const site = new URL(rawSiteUrl);
const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(site.hostname);
if (site.protocol !== "https:" && !(site.protocol === "http:" && isLoopback)) {
  throw new Error(
    "The prompt publisher requires HTTPS except on loopback hosts.",
  );
}
if (site.username || site.password) {
  throw new Error("The prompt publisher URL must not contain credentials.");
}
site.pathname = site.pathname.replace(/\/+$/, "");

const { STELLA_PROMPT_DEFAULTS } =
  await import("../convex/stella_prompt_defaults.generated");
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const prompts = await Promise.all(
  STELLA_PROMPT_IDS.map(async (id) => ({
    id,
    content: await fs.readFile(
      path.join(root, "prompts/stella-runtime", id),
      "utf-8",
    ),
  })),
);
const hashed = prompts
  .map((prompt) => ({ ...prompt, sha256: sha256(prompt.content) }))
  .sort((a, b) => a.id.localeCompare(b.id));
const revision = sha256(
  hashed.map((prompt) => `${prompt.id}:${prompt.sha256}`).join("\n"),
);
const generatedHashes = new Map(
  STELLA_PROMPT_DEFAULTS.prompts.map((prompt) => [prompt.id, prompt.sha256]),
);
if (
  revision !== STELLA_PROMPT_DEFAULTS.revision ||
  hashed.some((prompt) => generatedHashes.get(prompt.id) !== prompt.sha256)
) {
  throw new Error(
    "Canonical prompt files do not match the generated snapshot; run prompts:sync-defaults.",
  );
}

console.log(
  await publishStellaPromptsRequest({
    endpoint: new URL("/api/admin/stella/prompts", site),
    token,
    revision,
    prompts,
  }),
);
