#!/usr/bin/env node

// Backend-owned administrative publisher. This script requires Composio and
// Stella admin credentials and must never be shipped with the desktop runtime.
import AjvModule from "ajv";
import {
  codeModePolicyForAction,
  reviewedCodeModeActionKeys,
} from "./composio-code-mode-policy.mjs";
import {
  assertCatalogPageWithinLimit,
  readCatalogResponseTextBounded,
  setCatalogEntryBounded,
} from "./composio-catalog-io.mjs";

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
  "https://backend.composio.dev/api/v3.1/tools";
const composioToolkitsUrl =
  process.env.COMPOSIO_TOOLKITS_URL ||
  "https://backend.composio.dev/api/v3.1/toolkits";
const apply = process.argv.includes("--apply");
const MAX_ACTIONS_PER_INTEGRATION = 2_000;
const MAX_TOTAL_ACTIONS = 40_000;
const MAX_TOTAL_ACTION_BYTES = 64 * 1024 * 1024;
const MAX_ACTION_SCHEMA_BYTES = 64 * 1024;
const MAX_PUBLISH_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_PUBLISH_BODY_BYTES = 64 * 1024 * 1024;
const MAX_COMPOSIO_CATALOG_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_ADMIN_RESPONSE_BYTES = 64 * 1024;
const TOOL_PAGE_SIZE = 1_000;
const MAX_PROVIDER_ITEMS_PER_PAGE = TOOL_PAGE_SIZE;
const MAX_TOOLKIT_PAGES = 8;
const MAX_ACTION_PAGES_PER_INTEGRATION = 4;
const FETCH_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.COMPOSIO_CATALOG_CONCURRENCY || "6"), 12),
);
const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;
const Ajv = AjvModule.default ?? AjvModule;

const hasCompilableSchema = (schema) => {
  try {
    new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: false,
      validateFormats: false,
      logger: false,
    }).compile(schema);
    return true;
  } catch {
    return false;
  }
};

// The supported Store surface is explicit. Every entry below must currently be
// non-deprecated and support Composio-managed OAuth; official Composio APIs
// supply all metadata and schemas.
const SUPPORTED_TOOLKIT_IDS = new Set([
  "airtable", "apaleo", "asana", "attio", "basecamp", "bitbucket",
  "blackbaud", "boldsign", "box", "cal", "calendly", "canva", "capsule_crm",
  "clickup", "confluence", "contentful", "crowdin", "dart", "dialpad",
  "digital_ocean", "dropbox", "dub", "dynamics365", "eventbrite", "excel",
  "exist", "facebook", "fathom", "figma", "freeagent", "freshbooks",
  "github", "gitlab", "gmail", "gong", "google_analytics",
  "google_classroom", "google_maps", "google_search_console", "googleads",
  "googlebigquery", "googlecalendar", "googledocs", "googledrive",
  "googlemeet", "googlephotos", "googlesheets", "googleslides",
  "googlesuper", "googletasks", "gorgias", "gumroad", "harvest", "hubspot",
  "hugging_face", "instagram", "intercom", "jira", "kit", "linear",
  "linkedin", "linkhut", "mailchimp", "miro", "monday", "moneybird", "mural",
  "notion", "omnisend", "one_drive", "outlook", "pagerduty", "prisma",
  "productboard", "pushbullet", "quickbooks", "reddit", "salesforce", "sentry",
  "servicem8", "share_point", "shippo", "shopify", "splitwise", "square",
  "stack_exchange", "strava", "stripe", "supabase", "ticktick", "timely",
  "todoist", "toneden", "typeform", "wakatime", "webex", "wrike",
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
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "properties" || !isObject(child)) {
      // A properties block owns normalization of its adjacent required array.
      if (key === "required" && isObject(value.properties)) continue;
      normalized[key] = normalizeSchemaNode(child);
      continue;
    }

    // Normalize property schemas without recursively treating the property map
    // itself as a schema. Real APIs can have a field literally named
    // `properties` (for example BigQuery Spark options).
    const required = new Set(
      Array.isArray(value.required)
        ? value.required.filter((name) => typeof name === "string")
        : [],
    );
    const properties = {};
    for (const [name, rawProperty] of Object.entries(child)) {
      if (!isObject(rawProperty)) return null;
      if (rawProperty.required === true) required.add(name);
      const property = normalizeSchemaNode(rawProperty);
      if (!isObject(property)) return null;
      if (typeof property.required === "boolean") delete property.required;
      properties[name] = property;
    }
    normalized.properties = properties;
    if (required.size > 0) normalized.required = [...required];
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

// Composio's catalog publishes behavioral tags used by Tool Router session
// filters. Only that structured field is authoritative here: slugs,
// descriptions, scopes, and HTTP-looking words are never treated as a safety
// classification. Missing tags stay missing in Convex and therefore cannot be
// invoked from Code.
const annotationsFromComposioTool = (tool) => {
  if (!Array.isArray(tool.tags)) return undefined;
  const tags = new Set(
    tool.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim()),
  );
  return {
    readOnlyHint: tags.has("readOnlyHint"),
    destructiveHint: tags.has("destructiveHint"),
    idempotentHint: tags.has("idempotentHint"),
    source: "composio_tool_tags",
  };
};

const actionFromComposioTool = (row, tool, codeModePolicy) => {
  if (!isObject(tool)) return null;
  const name = typeof tool.slug === "string" ? tool.slug.trim() : "";
  const toolkit =
    isObject(tool.toolkit) && typeof tool.toolkit.slug === "string"
      ? tool.toolkit.slug.trim().toLowerCase()
      : "";
  if (toolkit !== row.id || !SAFE_ACTION_NAME.test(name)) return null;
  const inputSchema = schemaFromComposioTool(tool);
  if (!inputSchema || !hasCompilableSchema(inputSchema)) return null;
  if (Buffer.byteLength(JSON.stringify(inputSchema)) > MAX_ACTION_SCHEMA_BYTES) {
    return null;
  }
  return {
    name,
    title:
      (typeof tool.name === "string" && tool.name.trim()) ||
      titleFromSlug(name),
    description:
      (typeof tool.human_description === "string" &&
        tool.human_description.trim()) ||
      (typeof tool.description === "string" && tool.description.trim()) ||
      undefined,
    annotations: annotationsFromComposioTool(tool),
    ...(codeModePolicy ? { codeModePolicy } : {}),
    inputSchema,
  };
};

const exactToolFromPayload = (payload) => {
  if (!isObject(payload)) return null;
  if (isObject(payload.tool)) return payload.tool;
  if (isObject(payload.data)) return payload.data;
  return payload;
};

const toolVersionFromComposioTool = (tool) => {
  if (!isObject(tool)) return null;
  if (typeof tool.version === "string") return tool.version.trim();
  if (typeof tool.toolkit_version === "string") {
    return tool.toolkit_version.trim();
  }
  return isObject(tool.toolkit) && typeof tool.toolkit.version === "string"
    ? tool.toolkit.version.trim()
    : null;
};

const fetchComposioJson = async (url, label) => {
  const response = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": composioApiKey },
    redirect: "error",
  });
  const text = await readCatalogResponseTextBounded(
    response,
    MAX_COMPOSIO_CATALOG_PAGE_BYTES,
    label,
  );
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
  for (let page = 0; ; page += 1) {
    assertCatalogPageWithinLimit(page, MAX_TOOLKIT_PAGES, "toolkit catalog");
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
    if (payload.items.length > MAX_PROVIDER_ITEMS_PER_PAGE) {
      throw new Error("Composio toolkit page exceeds its item limit.");
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
      if (shouldPublish(entry)) {
        setCatalogEntryBounded(
          rows,
          id,
          toBaseRow(entry),
          SUPPORTED_TOOLKIT_IDS.size,
          "toolkit catalog",
        );
      }
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

const fetchToolkitActions = async (row, aggregateBudget) => {
  const actions = new Map();
  let skippedActionCount = 0;
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; ; page += 1) {
    assertCatalogPageWithinLimit(
      page,
      MAX_ACTION_PAGES_PER_INTEGRATION,
      `${row.id} action catalog`,
    );
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
    if (payload.items.length > MAX_PROVIDER_ITEMS_PER_PAGE) {
      throw new Error(`${row.id}: Composio tools page exceeds its item limit.`);
    }
    for (const tool of payload.items) {
      const name = isObject(tool) && typeof tool.slug === "string"
        ? tool.slug.trim()
        : "<unknown>";
      const normalized = actionFromComposioTool(row, tool);
      if (!normalized) {
        skippedActionCount += 1;
        continue;
      }
      // The general Store catalog may follow `latest`, but no Code policy is
      // attached here. Reviewed actions are replaced below only after fetching
      // and checking their exact dated provider contract.
      if (actions.has(normalized.name)) {
        throw new Error(
          `${row.id}: Composio repeated action ${normalized.name}.`,
        );
      }
      const retainedBytes = Buffer.byteLength(JSON.stringify(normalized));
      if (
        aggregateBudget.actions >= MAX_TOTAL_ACTIONS ||
        aggregateBudget.bytes + retainedBytes > MAX_TOTAL_ACTION_BYTES
      ) {
        throw new Error("Composio action catalog exceeds its aggregate budget.");
      }
      setCatalogEntryBounded(
        actions,
        normalized.name,
        normalized,
        MAX_ACTIONS_PER_INTEGRATION,
        `${row.id} action catalog`,
      );
      aggregateBudget.actions += 1;
      aggregateBudget.bytes += retainedBytes;
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

  for (const reviewedKey of reviewedCodeModeActionKeys()) {
    const separator = reviewedKey.indexOf(":");
    const integrationId = reviewedKey.slice(0, separator);
    const actionName = reviewedKey.slice(separator + 1);
    if (integrationId !== row.id) continue;
    const policy = codeModePolicyForAction(integrationId, actionName);
    if (!policy) {
      throw new Error(`${reviewedKey}: reviewed policy is unavailable.`);
    }
    const exactUrl = new URL(
      `${composioToolsUrl.replace(/\/$/u, "")}/${encodeURIComponent(actionName)}`,
    );
    exactUrl.searchParams.set("version", policy.toolkitVersion);
    const payload = await fetchComposioJson(
      exactUrl,
      `${reviewedKey}@${policy.toolkitVersion}`,
    );
    const exactTool = exactToolFromPayload(payload);
    if (
      !exactTool ||
      toolVersionFromComposioTool(exactTool) !== policy.toolkitVersion
    ) {
      throw new Error(
        `${reviewedKey}: Composio did not return the exact reviewed toolkit version ${policy.toolkitVersion}.`,
      );
    }
    const reviewed = actionFromComposioTool(row, exactTool, policy);
    if (
      !reviewed ||
      reviewed.name !== actionName ||
      reviewed.annotations?.readOnlyHint !== true ||
      reviewed.annotations.destructiveHint !== false ||
      !hasCompilableSchema(policy.reviewedInputSchema)
    ) {
      throw new Error(
        `${reviewedKey}: exact provider contract no longer satisfies the independent Stella Code review.`,
      );
    }
    if (!actions.has(actionName)) {
      throw new Error(
        `${reviewedKey}: the reviewed action is absent from the general catalog.`,
      );
    }
    const previousBytes = Buffer.byteLength(
      JSON.stringify(actions.get(actionName)),
    );
    const reviewedBytes = Buffer.byteLength(JSON.stringify(reviewed));
    if (
      aggregateBudget.bytes - previousBytes + reviewedBytes >
      MAX_TOTAL_ACTION_BYTES
    ) {
      throw new Error("Composio action catalog exceeds its aggregate budget.");
    }
    aggregateBudget.bytes =
      aggregateBudget.bytes - previousBytes + reviewedBytes;
    actions.set(actionName, reviewed);
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
  return {
    publication: { ...row, actions: sorted, catalogToolCount: sorted.length },
    skippedActionCount,
  };
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
        actionSource: "Composio v3.1 tools API",
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
        actionSource: "Composio v3.1 tools API (resolved during --apply)",
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
const aggregateCatalogBudget = { actions: 0, bytes: 0 };
const resolvedRows = await mapConcurrent(rows, FETCH_CONCURRENCY, async (row) => {
  return await fetchToolkitActions(row, aggregateCatalogBudget);
});
const publishedActionKeys = new Set(
  resolvedRows.flatMap(({ publication }) =>
    publication.actions.map((action) => `${publication.id}:${action.name}`),
  ),
);
const missingReviewedActions = reviewedCodeModeActionKeys().filter(
  (key) => !publishedActionKeys.has(key),
);
if (missingReviewedActions.length > 0) {
  throw new Error(
    `Stella-reviewed Code actions are absent from the live catalog: ${missingReviewedActions.join(", ")}. Re-review the policy manifest before publishing.`,
  );
}
let aggregatePublishBytes = 0;
const publicationBodies = resolvedRows.map(({ publication }) => {
  const body = JSON.stringify(publication);
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > MAX_PUBLISH_BODY_BYTES) {
    throw new Error(
      `${publication.id}: publication exceeds ${MAX_PUBLISH_BODY_BYTES} bytes.`,
    );
  }
  aggregatePublishBytes += bodyBytes;
  if (aggregatePublishBytes > MAX_TOTAL_PUBLISH_BODY_BYTES) {
    throw new Error(
      `Publication set exceeds ${MAX_TOTAL_PUBLISH_BODY_BYTES} bytes.`,
    );
  }
  return { publication, body };
});

for (const { publication, body } of publicationBodies) {
  const response = await fetch(
    `${siteUrl}/api/admin/native-integrations/upsert`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body,
    },
  );
  if (!response.ok) {
    const text = await readCatalogResponseTextBounded(
      response,
      MAX_ADMIN_RESPONSE_BYTES,
      publication.id,
    );
    throw new Error(
      `${publication.id}: ${response.status} ${text.slice(0, 500)}`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      published: publicationBodies.length,
      actions: publicationBodies.reduce(
        (sum, row) => sum + row.publication.actions.length,
        0,
      ),
      skippedActions: resolvedRows.reduce(
        (sum, row) => sum + row.skippedActionCount,
        0,
      ),
      skippedByToolkit: resolvedRows
        .filter((row) => row.skippedActionCount > 0)
        .map((row) => ({
          id: row.publication.id,
          count: row.skippedActionCount,
        })),
    },
    null,
    2,
  )}\n`,
);
