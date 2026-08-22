import { requireString, type ConnectorAdapter } from "./types.js";

const APOLLO_TASK_TYPES = [
  "call",
  "outreach_manual_email",
  "linkedin_step_connect",
  "linkedin_step_message",
  "linkedin_step_view_profile",
  "linkedin_step_interact_post",
  "action_item",
] as const;
const APOLLO_TASK_STATUSES = ["scheduled", "completed", "skipped"] as const;
const APOLLO_TASK_PRIORITIES = ["high", "medium", "low"] as const;

type ApolloQueryParameter = readonly [
  inputName: string,
  apiName: string,
  shape: "scalar" | "array",
];

const apolloQueryPath = (
  path: string,
  input: Record<string, unknown>,
  parameters: readonly ApolloQueryParameter[],
): string => {
  const url = new URL(path, "https://api.apollo.io");
  for (const [inputName, apiName, shape] of parameters) {
    const value = input[inputName];
    if (value === undefined) continue;
    if (shape === "array") {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string")
      ) {
        throw new Error(
          `Apollo requires \`${inputName}\` to be a string array.`,
        );
      }
      for (const item of value) url.searchParams.append(apiName, item);
      continue;
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(`Apollo requires \`${inputName}\` to be a scalar value.`);
    }
    url.searchParams.set(apiName, String(value));
  }
  return `${url.pathname}${url.search}`;
};

const pickDefined = (
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    keys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );

const requireOneOf = (
  input: Record<string, unknown>,
  key: string,
  action: string,
  allowed: readonly string[],
): string => {
  const value = requireString(input, key, action);
  if (!allowed.includes(value)) {
    throw new Error(`${action} received an unsupported \`${key}\` value.`);
  }
  return value;
};

/**
 * Apollo.io API v1 — https://docs.apollo.io/reference
 * Auth: API key via the `X-Api-Key` header. Base: https://api.apollo.io/api/v1
 */
export const APOLLO_ADAPTER: ConnectorAdapter = {
  id: "apollo",
  displayName: "Apollo",
  auth: "api_key",
  baseUrl: "https://api.apollo.io",
  apiAuthScheme: "raw",
  authHeaderName: "X-Api-Key",
  docsUrl: "https://docs.apollo.io/reference",
  actions: [
    {
      name: "APOLLO_PEOPLE_SEARCH",
      title: "People Search",
      description:
        "Search Apollo's people database without consuming enrichment credits.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          page: { type: "integer", minimum: 1, maximum: 500 },
          per_page: { type: "integer", minimum: 1, maximum: 100 },
          q_keywords: { type: "string" },
          person_titles: { type: "array", items: { type: "string" } },
          organization_ids: { type: "array", items: { type: "string" } },
          person_locations: { type: "array", items: { type: "string" } },
          person_seniorities: { type: "array", items: { type: "string" } },
          contact_email_status: {
            type: "array",
            items: {
              enum: [
                "verified",
                "unverified",
                "likely to engage",
                "unavailable",
              ],
            },
          },
          organization_locations: {
            type: "array",
            items: { type: "string" },
          },
          q_organization_domains: {
            type: "array",
            items: { type: "string" },
          },
          organization_num_employees_ranges: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: apolloQueryPath("/api/v1/mixed_people/api_search", input, [
          ["page", "page", "scalar"],
          ["per_page", "per_page", "scalar"],
          ["q_keywords", "q_keywords", "scalar"],
          ["person_titles", "person_titles[]", "array"],
          ["organization_ids", "organization_ids[]", "array"],
          ["person_locations", "person_locations[]", "array"],
          ["person_seniorities", "person_seniorities[]", "array"],
          ["contact_email_status", "contact_email_status[]", "array"],
          ["organization_locations", "organization_locations[]", "array"],
          ["q_organization_domains", "q_organization_domains_list[]", "array"],
          [
            "organization_num_employees_ranges",
            "organization_num_employees_ranges[]",
            "array",
          ],
        ]),
      }),
    },
    {
      name: "APOLLO_ORGANIZATION_SEARCH",
      title: "Organization Search",
      description: "Search Apollo's organization/company database.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          page: { type: "integer", minimum: 1, maximum: 500 },
          per_page: { type: "integer", minimum: 1, maximum: 100 },
          organization_ids: { type: "array", items: { type: "string" } },
          q_organization_name: { type: "string" },
          organization_locations: {
            type: "array",
            items: { type: "string" },
          },
          organization_not_locations: {
            type: "array",
            items: { type: "string" },
          },
          q_organization_domains_list: {
            type: "array",
            items: { type: "string" },
          },
          q_organization_keyword_tags: {
            type: "array",
            items: { type: "string" },
          },
          organization_num_employees_ranges: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      buildRequest: (input) => ({
        method: "POST",
        path: apolloQueryPath("/api/v1/mixed_companies/search", input, [
          ["page", "page", "scalar"],
          ["per_page", "per_page", "scalar"],
          ["organization_ids", "organization_ids[]", "array"],
          ["q_organization_name", "q_organization_name", "scalar"],
          ["organization_locations", "organization_locations[]", "array"],
          [
            "organization_not_locations",
            "organization_not_locations[]",
            "array",
          ],
          [
            "q_organization_domains_list",
            "q_organization_domains_list[]",
            "array",
          ],
          [
            "q_organization_keyword_tags",
            "q_organization_keyword_tags[]",
            "array",
          ],
          [
            "organization_num_employees_ranges",
            "organization_num_employees_ranges[]",
            "array",
          ],
        ]),
      }),
    },
    {
      name: "APOLLO_PEOPLE_ENRICH",
      title: "Enrich Person",
      description:
        "Enrich a single person by Apollo ID, email, name and company, or LinkedIn URL.",
      kind: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          domain: { type: "string" },
          last_name: { type: "string" },
          first_name: { type: "string" },
          webhook_url: { type: "string" },
          hashed_email: { type: "string" },
          linkedin_url: { type: "string" },
          organization_name: { type: "string" },
          reveal_phone_number: { type: "boolean" },
          reveal_personal_emails: { type: "boolean" },
        },
        anyOf: [
          { required: ["id"] },
          { required: ["email"] },
          { required: ["hashed_email"] },
          { required: ["linkedin_url"] },
          { required: ["first_name", "last_name", "organization_name"] },
          { required: ["first_name", "last_name", "domain"] },
        ],
        allOf: [
          {
            if: {
              properties: { reveal_phone_number: { const: true } },
              required: ["reveal_phone_number"],
            },
            then: { required: ["webhook_url"] },
          },
        ],
      },
      buildRequest: (input) => ({
        method: "POST",
        path: apolloQueryPath("/api/v1/people/match", input, [
          ["id", "id", "scalar"],
          ["name", "name", "scalar"],
          ["email", "email", "scalar"],
          ["domain", "domain", "scalar"],
          ["last_name", "last_name", "scalar"],
          ["first_name", "first_name", "scalar"],
          ["webhook_url", "webhook_url", "scalar"],
          ["hashed_email", "hashed_email", "scalar"],
          ["linkedin_url", "linkedin_url", "scalar"],
          ["organization_name", "organization_name", "scalar"],
          ["reveal_phone_number", "reveal_phone_number", "scalar"],
          ["reveal_personal_emails", "reveal_personal_emails", "scalar"],
        ]),
      }),
    },
    {
      name: "APOLLO_CREATE_CONTACT",
      title: "Create Contact",
      description: "Create a contact in the Apollo account.",
      kind: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["first_name", "last_name"],
        properties: {
          email: { type: "string" },
          title: { type: "string" },
          last_name: { type: "string", minLength: 1 },
          account_id: { type: "string" },
          first_name: { type: "string", minLength: 1 },
          home_phone: { type: "string" },
          label_names: { type: "array", items: { type: "string" } },
          other_phone: { type: "string" },
          website_url: { type: "string" },
          direct_phone: { type: "string" },
          mobile_phone: { type: "string" },
          corporate_phone: { type: "string" },
          contact_stage_id: { type: "string" },
          organization_name: { type: "string" },
          present_raw_address: { type: "string" },
        },
      },
      buildRequest: (input) => {
        const body = pickDefined(input, [
          "email",
          "title",
          "last_name",
          "account_id",
          "first_name",
          "home_phone",
          "label_names",
          "other_phone",
          "website_url",
          "direct_phone",
          "mobile_phone",
          "corporate_phone",
          "contact_stage_id",
          "organization_name",
          "present_raw_address",
        ]);
        body.first_name = requireString(
          input,
          "first_name",
          "APOLLO_CREATE_CONTACT",
        );
        body.last_name = requireString(
          input,
          "last_name",
          "APOLLO_CREATE_CONTACT",
        );
        return { method: "POST", path: "/api/v1/contacts", body };
      },
    },
    {
      name: "APOLLO_CREATE_TASK",
      title: "Create Task",
      description: "Create one task for one Apollo contact.",
      kind: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["user_id", "contact_id", "type", "status", "due_at"],
        properties: {
          note: { type: "string" },
          type: { enum: APOLLO_TASK_TYPES },
          title: { type: "string" },
          due_at: { type: "string", minLength: 1 },
          status: { enum: APOLLO_TASK_STATUSES },
          user_id: { type: "string", minLength: 1 },
          priority: { enum: APOLLO_TASK_PRIORITIES },
          contact_id: { type: "string", minLength: 1 },
        },
      },
      buildRequest: (input) => {
        const body = pickDefined(input, [
          "note",
          "type",
          "title",
          "due_at",
          "status",
          "user_id",
          "priority",
          "contact_id",
        ]);
        body.type = requireOneOf(
          input,
          "type",
          "APOLLO_CREATE_TASK",
          APOLLO_TASK_TYPES,
        );
        body.status = requireOneOf(
          input,
          "status",
          "APOLLO_CREATE_TASK",
          APOLLO_TASK_STATUSES,
        );
        body.user_id = requireString(input, "user_id", "APOLLO_CREATE_TASK");
        body.contact_id = requireString(
          input,
          "contact_id",
          "APOLLO_CREATE_TASK",
        );
        body.due_at = requireString(input, "due_at", "APOLLO_CREATE_TASK");
        if (input.priority !== undefined) {
          body.priority = requireOneOf(
            input,
            "priority",
            "APOLLO_CREATE_TASK",
            APOLLO_TASK_PRIORITIES,
          );
        }
        return { method: "POST", path: "/api/v1/tasks", body };
      },
    },
  ],
};
