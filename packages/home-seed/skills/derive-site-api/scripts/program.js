#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const TELEMETRY_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "google.com/pagead",
  "facebook.com/tr",
  "connect.facebook.net",
  "segment.io",
  "segment.com",
  "amplitude.com",
  "mixpanel.com",
  "sentry.io",
  "bugsnag.com",
  "datadoghq.com",
  "newrelic.com",
  "nr-data.net",
  "hotjar.com",
  "fullstory.com",
  "logrocket.com",
  "optimizely.com",
  "launchdarkly.com",
  "split.io",
  "branch.io",
  "appsflyer.com",
  "adjust.com",
  "braze.com",
  "onetrust.com",
  "cookielaw.org",
  "cloudflareinsights.com",
  "clarity.ms",
  "quantserve.com",
  "scorecardresearch.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "snowplowanalytics.com",
  "heap.io",
  "intercom.io",
  "zendesk.com",
  "statsig.com",
  "posthog.com"
];
const TELEMETRY_PATH_HINTS = [
  "/analytics",
  "/telemetry",
  "/metrics",
  "/beacon",
  "/collect",
  "/track",
  "/pixel",
  "/log-event",
  "/logevent",
  "/errors",
  "/rum",
  "/sentry",
  "/experiment",
  "/heartbeat",
  "/ping"
];
const CREDENTIAL_HEADERS =  new Set([
  "authorization",
  "cookie",
  "x-csrf-token",
  "x-xsrf-token",
  "csrf-token",
  "x-auth-token",
  "x-api-key",
  "api-key",
  "x-access-token",
  "x-session-token",
  "x-session-id",
  "x-token",
  "authentication",
  "x-amz-security-token"
]);
const BORING_HEADERS =  new Set([
  "accept-encoding",
  "accept-language",
  "cache-control",
  "pragma",
  "connection",
  "host",
  "user-agent",
  "referer",
  "origin",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "upgrade-insecure-requests",
  "dnt",
  "te",
  "priority",
  "content-length",
  "accept"
]);
const SENSITIVE_KEY = /(token|secret|password|passwd|auth|session|cookie|credential|signature|api[-_]?key|access[-_]?key|ssn|cvv|card|iban|account[-_]?number|email|phone|latitude|longitude|lat|lng|address|first[-_]?name|last[-_]?name|full[-_]?name)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const OPAQUE_ID = /^[A-Za-z0-9_-]{20,}$/;
const args = process.argv.slice(2);
const harPath = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : void 0;
};
const hasFlag = (name) => args.includes(`--${name}`);
if (!harPath) {
  console.error("usage: bun program.js <har.json> [--out report.md] [--json surface.json]");
  process.exit(2);
}
const maxEndpoints = Number(flag("max-endpoints") ?? 60);
const includeTelemetry = hasFlag("include-telemetry");
const raw = JSON.parse(readFileSync(harPath, "utf8"));
const entries = raw?.log?.entries ?? raw?.data?.log?.entries ?? raw?.entries ?? [];
if (!Array.isArray(entries) || entries.length === 0) {
  console.error(`No HAR entries found in ${harPath}.`);
  process.exit(1);
}
const isTelemetry = (url) => {
  const lower = url.toLowerCase();
  if (TELEMETRY_HOSTS.some((host) => lower.includes(host))) return true;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return TELEMETRY_PATH_HINTS.some((hint) => pathname.includes(hint));
  } catch {
    return false;
  }
};
const isStreamEntry = (entry) => entry._resourceType === "WebSocket" || entry._resourceType === "EventSource";
const looksLikeApi = (entry) => {
  const resourceType = entry._resourceType;
  if (resourceType === "XHR" || resourceType === "Fetch") return true;
  if (isStreamEntry(entry)) return true;
  const mime = (entry.response?.content?.mimeType ?? "").toLowerCase();
  return mime.includes("json") || mime.includes("graphql");
};
const apiEntries = entries.filter((entry) => {
  if (!entry?.request?.url) return false;
  if (!looksLikeApi(entry)) return false;
  if (!includeTelemetry && isTelemetry(entry.request.url)) return false;
  return true;
});
const scalarShape = (key, value) => {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return `boolean (${value})`;
  if (type === "number") return `number (${value})`;
  if (type !== "string") return type;
  const text = value;
  if (SENSITIVE_KEY.test(key)) return `string <redacted, len ${text.length}>`;
  if (text.length > 60) return `string <len ${text.length}>`;
  return `string (${JSON.stringify(text)})`;
};
const inferShape = (value, key = "", depth = 0) => {
  if (depth > 7) return "\u2026";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const element = inferShape(value[0], key, depth);
    return value.length > 1 ? [element, `\u2026${value.length} items total`] : [element];
  }
  if (value && typeof value === "object") {
    const out = {};
    const keys = Object.keys(value);
    for (const childKey of keys.slice(0, 25)) {
      out[childKey] = inferShape(value[childKey], childKey, depth + 1);
    }
    if (keys.length > 25) out["\u2026"] = `${keys.length - 25} more keys`;
    return out;
  }
  return scalarShape(key, value);
};
const redactUrl = (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(name)) url.searchParams.set(name, "<redacted>");
  }
  return url.toString();
};
const structuralKey = (value, depth = 0) => {
  if (depth > 6) return "\u2026";
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${structuralKey(value[0], depth + 1)}]` : "[]";
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${key}:${structuralKey(value[key], depth + 1)}`).join(",")}}`;
  }
  return value === null ? "null" : typeof value;
};
const parseJson = (text) => {
  if (!text) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
};
const isObviousId = (segment) => {
  if (/^\d+$/.test(segment)) return "{id}";
  if (UUID.test(segment)) return "{uuid}";
  if (LONG_HEX.test(segment)) return "{hash}";
  if (OPAQUE_ID.test(segment) && !/^[a-z-]+$/i.test(segment)) return "{id}";
  return null;
};
const variableSegments =  new Set();
{
  const buckets =  new Map();
  for (const entry of apiEntries) {
    let url;
    try {
      url = new URL(entry.request.url);
    } catch {
      continue;
    }
    const segments = url.pathname.split("/");
    const bucketKey = `${entry.request.method}|${url.host}|${segments.length}`;
    let positions = buckets.get(bucketKey);
    if (!positions) {
      positions =  new Map();
      buckets.set(bucketKey, positions);
    }
    segments.forEach((segment, index) => {
      let seen = positions.get(index);
      if (!seen) {
        seen =  new Set();
        positions.set(index, seen);
      }
      seen.add(segment);
    });
  }
  for (const [bucketKey, positions] of buckets) {
    for (const [index, values] of positions) {
      if (values.size < 2) continue;
      const allIdShaped = [...values].every(
        (value) => /\d/.test(value) && value.length >= 3 && !/^v\d+$/i.test(value)
      );
      if (allIdShaped) variableSegments.add(`${bucketKey}|${index}`);
    }
  }
}
const templatePath = (method, host, pathname) => {
  const segments = pathname.split("/");
  const bucketKey = `${method}|${host}|${segments.length}`;
  return segments.map((segment, index) => {
    if (!segment) return segment;
    const obvious = isObviousId(segment);
    if (obvious) return obvious;
    if (variableSegments.has(`${bucketKey}|${index}`)) return "{id}";
    return segment;
  }).join("/");
};
const groups =  new Map();
for (const entry of apiEntries) {
  let url;
  try {
    url = new URL(entry.request.url);
  } catch {
    continue;
  }
  const requestBody = parseJson(entry.request.postData?.text);
  const isGraphql = url.pathname.includes("graphql") || (entry.request.postData?.mimeType ?? "").includes("graphql");
  let operation;
  let graphqlQuery;
  if (isGraphql && requestBody && typeof requestBody === "object") {
    const body = Array.isArray(requestBody) ? requestBody[0] : requestBody;
    operation = body?.operationName;
    graphqlQuery = body?.query;
  }
  const path = templatePath(entry.request.method, url.host, url.pathname);
  const key = `${entry.request.method} ${url.host}${path}${operation ? `#${operation}` : ""}`;
  let group = groups.get(key);
  if (!group) {
    group = {
      key,
      method: entry.request.method,
      host: url.host,
      path,
      operation,
      count: 0,
      statuses:  new Map(),
      queryParams:  new Map(),
      requestHeaders:  new Map(),
      graphqlQuery,
      sampleUrl: entry.request.url,
      streamKind: isStreamEntry(entry) ? entry._resourceType : void 0,
      frames: []
    };
    groups.set(key, group);
  }
  const frames = entry._webSocketMessages ?? entry._eventSourceMessages ?? [];
  if (frames.length > 0) group.frames.push(...frames);
  group.count += 1;
  group.statuses.set(entry.response.status, (group.statuses.get(entry.response.status) ?? 0) + 1);
  for (const [name, value] of url.searchParams) {
    if (!group.queryParams.has(name)) {
      group.queryParams.set(name, SENSITIVE_KEY.test(name) ? "<redacted>" : value.slice(0, 60));
    }
  }
  for (const header of entry.request.headers ?? []) {
    const name = header.name.toLowerCase();
    if (name.startsWith(":") || BORING_HEADERS.has(name)) continue;
    if (!group.requestHeaders.has(name)) {
      group.requestHeaders.set(
        name,
        CREDENTIAL_HEADERS.has(name) ? "<credential>" : header.value.slice(0, 80)
      );
    }
  }
  const successful = entry.response.status >= 200 && entry.response.status < 300;
  if (group.requestShape === void 0 && requestBody !== void 0) {
    group.requestShape = inferShape(requestBody);
  }
  if (group.responseShape === void 0 && successful) {
    const responseBody = parseJson(
      entry.response.content?.encoding === "base64" ? void 0 : entry.response.content?.text
    );
    if (responseBody !== void 0) group.responseShape = inferShape(responseBody);
  }
}
const credentialUsage =  new Map();
for (const group of groups.values()) {
  for (const name of group.requestHeaders.keys()) {
    if (CREDENTIAL_HEADERS.has(name)) {
      credentialUsage.set(name, (credentialUsage.get(name) ?? 0) + group.count);
    }
  }
}
const usesCookieAuth = credentialUsage.has("cookie");
const explicitCredentialHeaders = [...credentialUsage.keys()].filter((name) => name !== "cookie");
const authVerdict = () => {
  if (explicitCredentialHeaders.length === 0 && usesCookieAuth) {
    return "Cookie-only. The browser attaches these automatically, so a derived client needs no credential handling.";
  }
  if (explicitCredentialHeaders.length > 0) {
    return `Explicit credential header(s): ${explicitCredentialHeaders.join(", ")}. These are NOT attached automatically \u2014 the client must read each value from the live page (localStorage, a bootstrap response, or a meta tag) rather than hardcoding a captured value, which would expire.`;
  }
  return "No credential headers observed. These endpoints may be public, or the session may ride entirely on cookies not visible to the recorder.";
};
const ranked = [...groups.values()].sort((a, b) => {
  const aOk = [...a.statuses.keys()].some((s) => s < 400);
  const bOk = [...b.statuses.keys()].some((s) => s < 400);
  if (aOk !== bOk) return aOk ? -1 : 1;
  const aRich = a.responseShape !== void 0 ? 1 : 0;
  const bRich = b.responseShape !== void 0 ? 1 : 0;
  if (aRich !== bRich) return bRich - aRich;
  return b.count - a.count;
});
const shown = ranked.slice(0, maxEndpoints);
const hostCounts =  new Map();
for (const group of groups.values()) {
  hostCounts.set(group.host, (hostCounts.get(group.host) ?? 0) + group.count);
}
const fence = (value) => "```json\n" + JSON.stringify(value, null, 2) + "\n```";
const lines = [];
lines.push("# API surface");
lines.push("");
lines.push(
  `${entries.length} requests recorded \u2192 ${apiEntries.length} API calls \u2192 ${groups.size} distinct endpoints.`
);
const withBodies = apiEntries.filter((e) => typeof e.response.content?.text === "string").length;
lines.push(`Response bodies captured for ${withBodies} of ${apiEntries.length} API calls.`);
if (withBodies === 0) {
  lines.push("");
  lines.push(
    "> No response bodies were captured. Response shapes below will be empty. Re-record and confirm `har_start` ran before the traffic, since bodies can only be read while the recording is open."
  );
}
lines.push("");
lines.push("## Hosts");
lines.push("");
for (const [host, count] of [...hostCounts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`- \`${host}\` \u2014 ${count} calls`);
}
lines.push("");
lines.push("## Authentication");
lines.push("");
lines.push(authVerdict());
if (credentialUsage.size > 0) {
  lines.push("");
  for (const [name, count] of credentialUsage) {
    lines.push(`- \`${name}\` on ${count} calls`);
  }
}
lines.push("");
lines.push(`## Endpoints (${shown.length} of ${groups.size})`);
for (const group of shown) {
  lines.push("");
  lines.push(`### ${group.method} ${group.host}${group.path}`);
  if (group.operation) lines.push(`GraphQL operation: \`${group.operation}\``);
  const statuses = [...group.statuses.entries()].map(([s, c]) => `${s}\xD7${c}`).join(", ");
  lines.push(`Calls: ${group.count} \xB7 Status: ${statuses}`);
  lines.push(`Example: \`${redactUrl(group.sampleUrl).slice(0, 300)}\``);
  if (group.queryParams.size > 0) {
    lines.push("");
    lines.push("Query parameters:");
    for (const [name, value] of group.queryParams) lines.push(`- \`${name}\` = \`${value}\``);
  }
  const interesting = [...group.requestHeaders.entries()].filter(
    ([name]) => CREDENTIAL_HEADERS.has(name) || name.startsWith("x-") || name === "content-type"
  );
  if (interesting.length > 0) {
    lines.push("");
    lines.push("Request headers:");
    for (const [name, value] of interesting) lines.push(`- \`${name}\`: \`${value}\``);
  }
  if (group.graphqlQuery) {
    lines.push("");
    lines.push("Query document:");
    lines.push("```graphql");
    lines.push(group.graphqlQuery.slice(0, 1500));
    lines.push("```");
  }
  if (group.frames.length > 0) {
    const bySignature =  new Map();
    for (const frame of group.frames) {
      let parsed;
      try {
        parsed = JSON.parse(frame.data ?? "");
      } catch {
        parsed = (frame.data ?? "").slice(0, 120);
      }
      const shape = inferShape(parsed);
      const signature = `${frame.type}:${structuralKey(parsed)}`;
      const seen = bySignature.get(signature);
      if (seen) seen.count += 1;
      else bySignature.set(signature, { direction: frame.type, shape, count: 1 });
    }
    lines.push("");
    lines.push(
      `${group.streamKind === "EventSource" ? "Event stream" : "Socket"} messages (${group.frames.length} frames, ${bySignature.size} distinct shapes):`
    );
    for (const message of [...bySignature.values()].sort((a, b) => b.count - a.count).slice(0, 12)) {
      lines.push("");
      lines.push(`- ${message.direction} \xD7${message.count}`);
      lines.push(fence(message.shape));
    }
  }
  if (group.requestShape !== void 0) {
    lines.push("");
    lines.push("Request body:");
    lines.push(fence(group.requestShape));
  }
  if (group.responseShape !== void 0) {
    lines.push("");
    lines.push("Response body:");
    lines.push(fence(group.responseShape));
  } else {
    lines.push("");
    lines.push("_No response body captured._");
  }
}
if (groups.size > shown.length) {
  lines.push("");
  lines.push(
    `_${groups.size - shown.length} lower-ranked endpoints omitted. Re-run with \`--max-endpoints ${groups.size}\` to see them._`
  );
}
const report = lines.join("\n");
const outPath = flag("out");
if (outPath) {
  writeFileSync(outPath, report, "utf8");
  console.log(`Wrote report to ${outPath} (${groups.size} endpoints from ${entries.length} requests).`);
} else {
  console.log(report);
}
const jsonPath = flag("json");
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        recordedRequests: entries.length,
        apiCalls: apiEntries.length,
        hosts: Object.fromEntries(hostCounts),
        auth: {
          cookieOnly: usesCookieAuth && explicitCredentialHeaders.length === 0,
          credentialHeaders: [...credentialUsage.keys()]
        },
        endpoints: ranked.map((group) => ({
          method: group.method,
          host: group.host,
          path: group.path,
          operation: group.operation,
          count: group.count,
          statuses: Object.fromEntries(group.statuses),
          queryParams: Object.fromEntries(group.queryParams),
          requestHeaders: Object.fromEntries(group.requestHeaders),
          requestShape: group.requestShape,
          responseShape: group.responseShape
        }))
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Wrote machine-readable surface to ${jsonPath}.`);
}
