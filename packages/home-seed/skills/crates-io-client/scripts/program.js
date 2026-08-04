#!/usr/bin/env bun
const BASE = "https://crates.io/api/v1";
const HEADERS = {
  accept: "application/json",
  "user-agent": "stella-crates-io-client (https://github.com/anthropics/stella)"
};
const args = process.argv.slice(2);
const command = args[0];
const VALUE_FLAGS = /* @__PURE__ */ new Set(["limit", "sort"]);
const parsedFlags = /* @__PURE__ */ new Map();
const positional = [];
for (let index = 1; index < args.length; index += 1) {
  const token = args[index];
  if (!token.startsWith("--")) {
    positional.push(token);
    continue;
  }
  const name = token.slice(2);
  if (VALUE_FLAGS.has(name)) {
    parsedFlags.set(name, args[index + 1] ?? "");
    index += 1;
  } else {
    parsedFlags.set(name, "true");
  }
}
const flag = (name) => parsedFlags.get(name);
const hasFlag = (name) => parsedFlags.has(name);
const limit = Number(flag("limit") ?? 10);
const raw = hasFlag("raw");
const die = (message) => {
  console.error(message);
  process.exit(1);
};
const get = async (path) => {
  const response = await fetch(`${BASE}${path}`, { headers: HEADERS });
  const text = await response.text();
  if (!response.ok) {
    die(`crates.io returned ${response.status} for ${path}
${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return die(`crates.io returned non-JSON for ${path} (${text.length} bytes)`);
  }
};
const emit = (value) => console.log(JSON.stringify(value, null, 2));
const trimCrate = (c) => ({
  name: c.name,
  version: c.newest_version ?? c.default_version ?? c.max_version,
  description: c.description,
  downloads: c.downloads,
  recentDownloads: c.recent_downloads,
  updatedAt: c.updated_at,
  homepage: c.homepage,
  repository: c.repository,
  documentation: c.documentation,
  keywords: c.keywords ?? void 0
});
switch (command) {
  case "search": {
    const query = positional.join(" ");
    if (!query) die("usage: search <query> [--limit N] [--sort ...]");
    const sort = flag("sort") ?? "relevance";
    const params = new URLSearchParams({
      q: query,
      page: "1",
      per_page: String(Math.min(limit, 100)),
      sort
    });
    const data = await get(`/crates?${params}`);
    emit(
      raw ? data : {
        total: data.meta?.total,
        crates: (data.crates ?? []).map(trimCrate)
      }
    );
    break;
  }
  case "crate": {
    const name = positional[0];
    if (!name) die("usage: crate <name>");
    const data = await get(`/crates/${encodeURIComponent(name)}`);
    emit(
      raw ? data : {
        ...trimCrate(data.crate ?? {}),
        categories: (data.categories ?? []).map((c) => c.category),
        recentVersions: (data.versions ?? []).slice(0, 5).map((v) => ({
          num: v.num,
          createdAt: v.created_at,
          downloads: v.downloads,
          yanked: v.yanked,
          rustVersion: v.rust_version ?? void 0
        }))
      }
    );
    break;
  }
  case "versions": {
    const name = positional[0];
    if (!name) die("usage: versions <name> [--limit N]");
    const data = await get(`/crates/${encodeURIComponent(name)}/versions`);
    const versions = (data.versions ?? []).slice(0, limit);
    emit(
      raw ? data : versions.map((v) => ({
        num: v.num,
        createdAt: v.created_at,
        downloads: v.downloads,
        yanked: v.yanked,
        license: v.license
      }))
    );
    break;
  }
  default:
    die(
      "usage:\n  bun program.js search <query> [--limit N] [--sort relevance|downloads|recent-downloads|new]\n  bun program.js crate <name>\n  bun program.js versions <name> [--limit N]\nAdd --raw to print the untrimmed response."
    );
}
