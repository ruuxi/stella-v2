#!/usr/bin/env node

// Backend-owned administrative publisher. This script requires Composio and
// Stella admin credentials and must never be shipped with the desktop runtime.

const siteUrl = (
  process.env.STELLA_CONVEX_SITE_URL ||
  process.env.CONVEX_SITE_URL ||
  ""
).replace(/\/+$/u, "");
const adminToken =
  process.env.STELLA_ADMIN_API_SECRET ||
  process.env.STELLA_ADMIN_TOKEN ||
  process.env.STELLA_ADMIN_SECRET ||
  process.env.ADMIN_TOKEN ||
  "";
const composioApiKey = process.env.COMPOSIO_API_KEY || "";
const composioToolsUrl =
  process.env.COMPOSIO_TOOLS_URL ||
  "https://backend.composio.dev/api/v3/tools";
const composioToolkitsUrl =
  process.env.COMPOSIO_TOOLKITS_URL ||
  "https://backend.composio.dev/api/v3.1/toolkits";
const apply = process.argv.includes("--apply");
const MAX_ACTIONS_PER_INTEGRATION = 2_000;
const MAX_ACTION_SCHEMA_BYTES = 64 * 1024;
const TOOL_PAGE_SIZE = 1_000;
const FETCH_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.COMPOSIO_CATALOG_CONCURRENCY || "6"), 12),
);
const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;

// The supported Store surface is explicit. Official Composio APIs supply all
// metadata and schemas; this manifest only decides which toolkits Stella ships.
const SUPPORTED_TOOLKIT_IDS = new Set([
  "airtable", "apaleo", "asana", "attio", "bamboohr", "basecamp",
  "beeminder", "bitbucket", "blackbaud", "blackboard", "boldsign", "box",
  "brevo", "brex", "cal", "calendly", "canva", "canvas", "capsule_crm",
  "clickup", "confluence", "contentful", "coupa", "crowdin",
  "d2lbrightspace", "dart", "databricks", "datadog", "dialpad",
  "digital_ocean", "docusign", "dropbox", "dropbox_sign", "dub",
  "dynamics365", "egnyte", "eventbrite", "excel", "exist", "facebook",
  "fathom", "figma", "fly", "follow_up_boss", "freeagent", "freshbooks",
  "github", "gitlab", "gmail", "gong", "google_admin", "google_analytics",
  "google_classroom", "google_maps", "google_search_console", "googleads",
  "googlebigquery", "googlecalendar", "googledocs", "googledrive",
  "googlemeet", "googlephotos", "googlesheets", "googleslides",
  "googlesuper", "googletasks", "gorgias", "gumroad", "harvest", "hubspot",
  "hugging_face", "instagram", "intercom", "jira", "kit", "klaviyo",
  "kommo", "lever", "linear", "linkedin", "linkhut", "mailchimp", "metaads",
  "miro", "monday", "moneybird", "mural", "netsuite", "notion", "omnisend",
  "one_drive", "outlook", "pagerduty", "pipedrive", "prisma", "productboard",
  "pushbullet", "quickbooks", "ramp", "reddit", "salesforce",
  "salesforce_service_cloud", "sentry", "servicem8", "share_point", "shippo",
  "shopify", "snowflake", "splitwise", "spotify", "square", "stack_exchange",
  "storyblok", "strava", "stripe", "supabase", "survey_monkey", "ticktick",
  "tiktok", "timely", "todoist", "toneden", "twitter", "typeform", "wakatime",
  "webex", "webflow", "whop", "workable", "workday", "wrike", "xata", "xero",
  "yandex", "ynab", "youtube", "zendesk", "zeplin", "zoho", "zoho_bigin",
  "zoho_books", "zoho_desk", "zoho_inventory", "zoho_invoice", "zoho_mail",
  "zoom",
]);

const shouldPublish = (entry) =>
  SUPPORTED_TOOLKIT_IDS.has(entry.id) &&
  entry.composioManagedAuthSchemes.includes("oauth2");

const isObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const titleFromSlug = (slug) =>
  slug
    .replace(/^[A-Z0-9]+_/u, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
    .join(" ");

const toBaseRow = (entry) => ({
  id: entry.id,
  name: entry.name,
  provider: "composio",
  category: entry.category || "integrations",
  auth: ["OAUTH2"],
  catalogToolCount: 0,
  actions: [],
  description: entry.description || `Connect ${entry.name || entry.id} to Stella.`,
  sourceUrl: `https://composio.dev/toolkits/${entry.id}`,
  iconUrl: entry.iconUrl || `https://logos.composio.dev/api/${entry.id}`,
  connector: {
    type: "composio",
    toolkit: entry.id,
    provider: "composio",
  },
  enabled: true,
  usagePolicy: "ready",
});

const normalizeSchemaNode = (value) => {
  if (Array.isArray(value)) return value.map(normalizeSchemaNode);
  if (!isObject(value)) return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      normalizeSchemaNode(child),
    ]),
  );
  if (isObject(value.properties)) {
    const required = new Set(
      Array.isArray(value.required)
        ? value.required.filter((name) => typeof name === "string")
        : [],
    );
    for (const [name, rawProperty] of Object.entries(value.properties)) {
      if (!isObject(rawProperty)) return null;
      if (rawProperty.required === true) required.add(name);
      const property = normalized.properties[name];
      if (!isObject(property)) return null;
      if (typeof property.required === "boolean") delete property.required;
    }
    normalized.required = required.size > 0 ? [...required] : undefined;
    if (normalized.required === undefined) delete normalized.required;
  }
  return normalized;
};

const normalizeObjectSchema = (value) => {
  if (!isObject(value)) return null;
  if (value.type === "object" || isObject(value.properties)) {
    const normalized = normalizeSchemaNode({
      ...value,
      type: "object",
      properties: isObject(value.properties) ? value.properties : {},
    });
    return isObject(normalized) ? normalized : null;
  }

  // The list-tools API also returns `input_parameters` as a field map whose
  // child definitions carry `required: boolean`. Convert it to JSON Schema.
  const wrapped = normalizeSchemaNode({
    type: "object",
    properties: value,
    additionalProperties: false,
  });
  return isObject(wrapped) ? wrapped : null;
};

const schemaFromComposioTool = (tool) =>
  normalizeObjectSchema(
    tool.input_schema ?? tool.inputSchema ?? tool.input_parameters,
  );

const fetchComposioJson = async (url, label) => {
  const response = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": composioApiKey },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label}: Composio returned ${response.status}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: Composio returned invalid JSON.`);
  }
};

const fetchPublishedToolkitRows = async () => {
  const rows = new Map();
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    const url = new URL(composioToolkitsUrl);
    url.searchParams.set("managed_by", "composio");
    url.searchParams.set("sort_by", "alphabetically");
    url.searchParams.set("include_deprecated", "false");
    url.searchParams.set("limit", String(TOOL_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = await fetchComposioJson(url, "toolkit catalog");
    if (!Array.isArray(payload.items)) {
      throw new Error("Composio toolkit catalog has no items array.");
    }
    for (const toolkit of payload.items) {
      if (!isObject(toolkit)) continue;
      const id =
        typeof toolkit.slug === "string"
          ? toolkit.slug.trim().toLowerCase()
          : "";
      if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(id)) continue;
      const composioManagedAuthSchemes = Array.isArray(
        toolkit.composio_managed_auth_schemes,
      )
        ? toolkit.composio_managed_auth_schemes
            .filter((value) => typeof value === "string")
            .map((value) => value.toLowerCase())
        : [];
      const entry = {
        id,
        name:
          typeof toolkit.name === "string" && toolkit.name.trim()
            ? toolkit.name.trim()
            : titleFromSlug(id.toUpperCase()),
        category:
          typeof toolkit.meta?.categories?.[0]?.name === "string"
            ? toolkit.meta.categories[0].name.toLowerCase()
            : "integrations",
        description:
          typeof toolkit.meta?.description === "string"
            ? toolkit.meta.description
            : undefined,
        iconUrl:
          typeof toolkit.meta?.logo === "string" ? toolkit.meta.logo : undefined,
        composioManagedAuthSchemes,
      };
      if (shouldPublish(entry)) rows.set(id, toBaseRow(entry));
    }
    const nextCursor =
      typeof payload.next_cursor === "string" && payload.next_cursor.trim()
        ? payload.next_cursor.trim()
        : null;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error("Composio repeated a toolkit pagination cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  const sorted = [...rows.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const missing = [...SUPPORTED_TOOLKIT_IDS].filter((id) => !rows.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Composio catalog is missing supported OAuth toolkits: ${missing.join(", ")}.`,
    );
  }
  return sorted;
};

const fetchToolkitActions = async (row) => {
  const actions = new Map();
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    const url = new URL(composioToolsUrl);
    url.searchParams.set("toolkit_slug", row.id);
    url.searchParams.set("toolkit_versions", "latest");
    url.searchParams.set("include_deprecated", "false");
    url.searchParams.set("limit", String(TOOL_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = await fetchComposioJson(url, row.id);
    if (!Array.isArray(payload.items)) {
      throw new Error(`${row.id}: Composio tools response has no items array.`);
    }
    for (const tool of payload.items) {
      if (!isObject(tool)) continue;
      const name = typeof tool.slug === "string" ? tool.slug.trim() : "";
      const toolkit =
        isObject(tool.toolkit) && typeof tool.toolkit.slug === "string"
          ? tool.toolkit.slug.trim().toLowerCase()
          : "";
      if (toolkit !== row.id || !SAFE_ACTION_NAME.test(name)) continue;
      const inputSchema = schemaFromComposioTool(tool);
      if (!inputSchema) {
        throw new Error(`${row.id}: ${name} has no usable input schema.`);
      }
      const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema));
      if (schemaBytes > MAX_ACTION_SCHEMA_BYTES) {
        throw new Error(
          `${row.id}: ${name} schema exceeds ${MAX_ACTION_SCHEMA_BYTES} bytes.`,
        );
      }
      actions.set(name, {
        name,
        title:
          (typeof tool.name === "string" && tool.name.trim()) ||
          titleFromSlug(name),
        description:
          (typeof tool.human_description === "string" &&
            tool.human_description.trim()) ||
          (typeof tool.description === "string" && tool.description.trim()) ||
          undefined,
        inputSchema,
      });
    }
    const nextCursor =
      typeof payload.next_cursor === "string" && payload.next_cursor.trim()
        ? payload.next_cursor.trim()
        : null;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`${row.id}: Composio repeated a pagination cursor.`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  const sorted = [...actions.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (sorted.length === 0) {
    throw new Error(`${row.id}: Composio returned zero schema-bearing actions.`);
  }
  if (sorted.length > MAX_ACTIONS_PER_INTEGRATION) {
    throw new Error(
      `${row.id}: action count exceeds ${MAX_ACTIONS_PER_INTEGRATION}.`,
    );
  }
  return { ...row, actions: sorted, catalogToolCount: sorted.length };
};

const mapConcurrent = async (values, concurrency, fn) => {
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
};

if (!composioApiKey) {
  if (apply) {
    process.stderr.write("Missing COMPOSIO_API_KEY.\n");
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        count: null,
        catalogSource: "Composio v3.1 toolkits API",
        actionSource: "Composio v3 tools API",
        hint: "Set COMPOSIO_API_KEY to preview; also set STELLA_CONVEX_SITE_URL and STELLA_ADMIN_TOKEN, then pass --apply to publish.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

let rows = await fetchPublishedToolkitRows();

if (!apply) {
  process.stdout.write(
    `${JSON.stringify(
      {
        count: rows.length,
        first: rows.slice(0, 5).map((row) => row.id),
        catalogSource: "Composio v3.1 toolkits API",
        actionSource: "Composio v3 tools API (resolved during --apply)",
        hint: "Set STELLA_CONVEX_SITE_URL and STELLA_ADMIN_TOKEN, then pass --apply to validate and publish.",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (!siteUrl || !adminToken) {
  process.stderr.write(
    "Missing STELLA_CONVEX_SITE_URL/CONVEX_SITE_URL or STELLA_ADMIN_TOKEN/STELLA_ADMIN_SECRET.\n",
  );
  process.exit(1);
}

// Resolve and validate the complete publication before mutating the backend.
// A provider/API failure therefore leaves every existing action set untouched.
rows = await mapConcurrent(rows, FETCH_CONCURRENCY, async (row) => {
  return await fetchToolkitActions(row);
});

for (const row of rows) {
  const response = await fetch(
    `${siteUrl}/api/admin/native-integrations/upsert`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(row),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${row.id}: ${response.status} ${text.slice(0, 500)}`);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      published: rows.length,
      actions: rows.reduce((sum, row) => sum + row.actions.length, 0),
    },
    null,
    2,
  )}\n`,
);
