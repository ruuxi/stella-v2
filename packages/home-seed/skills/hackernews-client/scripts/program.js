#!/usr/bin/env bun
const APP_ID = "UJ5WYC0L7X";
const SEARCH_KEY = "28f0e1ec37a5e792e6845e67da5f20dd";
const HOST = `https://${APP_ID.toLowerCase()}-dsn.algolia.net`;
const INDEX_BY_SORT = { relevance: "Item_dev", date: "Item_dev_sort_date" };
const args = process.argv.slice(2);
const command = args[0];
const VALUE_FLAGS = /* @__PURE__ */ new Set(["limit", "sort", "type", "min-points", "since"]);
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
const limit = Math.min(Number(flag("limit") ?? 20), 100);
const raw = hasFlag("raw");
const die = (message) => {
  console.error(message);
  process.exit(1);
};
const query = async (index, body) => {
  const params = new URLSearchParams({
    "x-algolia-api-key": SEARCH_KEY,
    "x-algolia-application-id": APP_ID
  });
  const response = await fetch(`${HOST}/1/indexes/${index}/query?${params}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    die(`Algolia returned ${response.status}
${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return die(`Algolia returned non-JSON (${text.length} bytes)`);
  }
};
const emit = (value) => console.log(JSON.stringify(value, null, 2));
const trimHit = (hit) => ({
  id: hit.objectID,
  title: hit.title ?? hit.story_title,
  url: hit.url ?? hit.story_url,
  author: hit.author,
  points: hit.points,
  comments: hit.num_comments,
  createdAt: hit.created_at,
  discussion: `https://news.ycombinator.com/item?id=${hit.story_id ?? hit.objectID}`,
  ...hit.comment_text ? { comment: String(hit.comment_text).slice(0, 400) } : {}
});
const buildFilters = () => {
  const type = flag("type") ?? "story";
  if (type === "all") return [];
  return [[type]];
};
const numericFilters = () => {
  const filters = [];
  const minPoints = flag("min-points");
  if (minPoints) filters.push(`points>=${Number(minPoints)}`);
  const since = flag("since");
  if (since) {
    const stamp = Math.floor(new Date(since).getTime() / 1e3);
    if (!Number.isFinite(stamp)) die(`--since must be a date, got ${since}`);
    filters.push(`created_at_i>=${stamp}`);
  }
  return filters;
};
switch (command) {
  case "search": {
    const text = positional.join(" ");
    if (!text) die("usage: search <query> [--limit N] [--sort relevance|date] ...");
    const sort = flag("sort") ?? "relevance";
    const index = INDEX_BY_SORT[sort];
    if (!index) die(`--sort must be relevance or date, got ${sort}`);
    const data = await query(index, {
      query: text,
      page: 0,
      hitsPerPage: limit,
      tagFilters: buildFilters(),
      numericFilters: numericFilters(),
      advancedSyntax: true
    });
    emit(raw ? data : { total: data.nbHits, hits: (data.hits ?? []).map(trimHit) });
    break;
  }
  case "front": {
    const data = await query(INDEX_BY_SORT.date, {
      query: "",
      page: 0,
      hitsPerPage: limit,
      tagFilters: [["front_page"]]
    });
    emit(raw ? data : { hits: (data.hits ?? []).map(trimHit) });
    break;
  }
  case "item": {
    const id = positional[0];
    if (!id) die("usage: item <id>");
    const response = await fetch(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(id)}`);
    const text = await response.text();
    if (!response.ok) die(`Algolia returned ${response.status}
${text.slice(0, 500)}`);
    const data = JSON.parse(text);
    const flatten = (node, depth = 0) => node.text || node.title ? [
      {
        depth,
        author: node.author,
        text: node.text ? String(node.text).slice(0, 600) : node.title,
        points: node.points ?? void 0
      },
      ...(node.children ?? []).flatMap((c) => flatten(c, depth + 1))
    ] : (node.children ?? []).flatMap((c) => flatten(c, depth));
    emit(raw ? data : { id: data.id, title: data.title, url: data.url, thread: flatten(data) });
    break;
  }
  default:
    die(
      "usage:\n  bun program.js search <query> [--limit N] [--sort relevance|date] [--type story|comment|all] [--min-points N] [--since YYYY-MM-DD]\n  bun program.js front [--limit N]\n  bun program.js item <id>\nAdd --raw to print the untrimmed response."
    );
}
