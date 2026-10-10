import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

const PRIVATE = ["/api/", "/auth/", "/billing", "/challenge"];

// Named groups for the AI search, assistant and training crawlers. A crawler
// that matches a named group ignores `*`, so each one carries the same rules;
// listing them makes the site's welcome explicit to the bots that decide
// whether Stella can be cited.
const AI_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "GPTBot",
  "Claude-SearchBot",
  "Claude-User",
  "ClaudeBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "Bingbot",
  "DuckAssistBot",
  "MistralAI-User",
  "Meta-ExternalAgent",
];

export default function robots(): MetadataRoute.Robots {
  const base = getSiteUrl();
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      { userAgent: AI_AGENTS, allow: "/", disallow: PRIVATE },
    ],
    sitemap: new URL("/sitemap.xml", base).href,
  };
}
