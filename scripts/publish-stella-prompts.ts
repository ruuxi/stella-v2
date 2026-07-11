import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const siteUrl = (
  process.env.STELLA_CONVEX_SITE_URL ??
  process.env.CONVEX_SITE_URL ??
  ""
)
  .trim()
  .replace(/\/+$/, "");
const token = (process.env.STELLA_ADMIN_API_SECRET ?? "").trim();
if (!siteUrl || !token) {
  throw new Error("Set STELLA_CONVEX_SITE_URL and STELLA_ADMIN_API_SECRET.");
}
const { STELLA_PROMPT_DEFAULTS } = await import(
  "../convex/stella_prompt_defaults.generated"
);
const prompts = await Promise.all(
  STELLA_PROMPT_DEFAULTS.prompts.map(async ({ id }) => ({
    id,
    content: await fs.readFile(
      path.join(root, "prompts/stella-runtime", id),
      "utf-8",
    ),
  })),
);
const response = await fetch(`${siteUrl}/api/admin/stella/prompts`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ revision: STELLA_PROMPT_DEFAULTS.revision, prompts }),
});
if (!response.ok)
  throw new Error(
    `Publish failed: HTTP ${response.status} ${await response.text()}`,
  );
console.log(await response.text());
