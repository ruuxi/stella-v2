import { ConnectorError } from "../errors";
import { isProviderEnabled } from "../env";
import {
  buildApiKeyProviderRequest,
  canonicalizeDeferredActionName,
  DEFERRED_API_KEY_PROVIDERS,
  type ApiKeyProviderRequest,
} from "../executors/api_key";

export type ApiKeyAuthPlacement =
  | { type: "bearer" }
  | {
      type: "header";
      headerName:
        | "x-api-key"
        | "X-Api-Key"
        | "X-User-API-Key"
        | "Key"
        | "X-API-Key"
        | "auth";
    }
  | { type: "query"; queryParam: "api_key" }
  | {
      type: "basic";
      format: "username_empty_password" | "credentials_pair";
    };

export type ApiKeyActionDescriptor = {
  operation: "read" | "write";
  inputSchema: Record<string, unknown>;
};

export type ApiKeyProviderDescriptor = {
  connectorId: string;
  providerKey: string;
  displayName: string;
  credentialLabel: string;
  apiOrigin: string;
  auth: ApiKeyAuthPlacement;
  actions: Readonly<Record<string, ApiKeyActionDescriptor>>;
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  additionalProperties = true,
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties,
});

const FIRECRAWL_ACTIONS = {
  FIRECRAWL_SCRAPE_EXTRACT_DATA_LLM: {
    operation: "read",
    inputSchema: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        formats: { type: "array" },
        onlyMainContent: { type: "boolean" },
        includeTags: { type: "array" },
        excludeTags: { type: "array" },
        waitFor: { type: "number" },
        timeout: { type: "number" },
      },
      ["url"],
    ),
  },
  FIRECRAWL_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        limit: { type: "number" },
        lang: { type: "string" },
        country: { type: "string" },
        location: { type: "string" },
        scrapeOptions: { type: "object" },
      },
      ["query"],
    ),
  },
  FIRECRAWL_CRAWL: {
    operation: "write",
    inputSchema: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        prompt: { type: "string" },
        includePaths: { type: "array" },
        excludePaths: { type: "array" },
        limit: { type: "number" },
        scrapeOptions: { type: "object" },
        webhook: { type: "object" },
      },
      ["url"],
    ),
  },
  FIRECRAWL_CRAWL_GET: {
    operation: "read",
    inputSchema: objectSchema(
      { id: { type: "string", minLength: 1 } },
      ["id"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const EXA_ACTIONS = {
  EXA_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        type: { type: "string" },
        category: { type: "string" },
        numResults: { type: "number" },
        contents: { type: "object" },
      },
      ["query"],
    ),
  },
  EXA_GET_CONTENTS_ACTION: {
    operation: "read",
    inputSchema: objectSchema(
      {
        ids: { type: "array", minItems: 1, items: { type: "string" } },
        text: {},
        highlights: {},
        summary: {},
      },
      ["ids"],
    ),
  },
  EXA_ANSWER: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        text: { type: "boolean" },
        stream: { type: "boolean" },
      },
      ["query"],
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const SERPAPI_ACTIONS = Object.fromEntries(
  ["SERPAPI_SEARCH", "SERPAPI_NEWS_SEARCH", "SERPAPI_BING_SEARCH"].map(
    (action) => [
      action,
      {
        operation: "read" as const,
        inputSchema: objectSchema(
          {
            q: { type: "string", minLength: 1 },
            location: { type: "string" },
            google_domain: { type: "string" },
            gl: { type: "string" },
            hl: { type: "string" },
            num: { type: "number" },
            start: { type: "number" },
            device: { type: "string" },
            safe: { type: "string" },
          },
          ["q"],
          false,
        ),
      },
    ],
  ),
) as Readonly<Record<string, ApiKeyActionDescriptor>>;

const ASHBY_ACTIONS = {
  ASHBY_LIST_CANDIDATES: {
    operation: "read",
    inputSchema: objectSchema(
      {
        limit: { type: "number" },
        cursor: { type: "string" },
        syncToken: { type: "string" },
      },
      [],
      false,
    ),
  },
  ASHBY_SEARCH_CANDIDATES: {
    operation: "read",
    inputSchema: objectSchema(
      { email: { type: "string" }, name: { type: "string" } },
      [],
      false,
    ),
  },
  ASHBY_CREATE_CANDIDATE: {
    operation: "write",
    inputSchema: objectSchema(
      {
        name: { type: "string", minLength: 1 },
        email: { type: "string" },
        phoneNumber: { type: "string" },
        linkedInUrl: { type: "string" },
      },
      ["name"],
    ),
  },
  ASHBY_LIST_JOBS: {
    operation: "read",
    inputSchema: objectSchema(
      { limit: { type: "number" }, cursor: { type: "string" } },
      [],
      false,
    ),
  },
  ASHBY_CREATE_NOTE: {
    operation: "write",
    inputSchema: objectSchema(
      {
        candidateId: { type: "string", minLength: 1 },
        note: { type: "string", minLength: 1 },
        sendNotifications: { type: "boolean" },
      },
      ["candidateId", "note"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const TAVILY_ACTIONS = {
  TAVILY_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        search_depth: { type: "string" },
        topic: { type: "string" },
        time_range: { type: "string" },
        days: { type: "number" },
        max_results: { type: "number" },
        include_domains: { type: "array", items: { type: "string" } },
        exclude_domains: { type: "array", items: { type: "string" } },
        include_answer: {},
        include_raw_content: {},
        include_images: { type: "boolean" },
        country: { type: "string" },
      },
      ["query"],
      false,
    ),
  },
  TAVILY_EXTRACT: {
    operation: "read",
    inputSchema: objectSchema(
      {
        urls: {
          oneOf: [
            { type: "string", minLength: 1 },
            {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          ],
        },
        query: { type: "string" },
        extract_depth: { type: "string" },
        include_images: { type: "boolean" },
        format: { type: "string" },
        timeout: { type: "number" },
      },
      ["urls"],
      false,
    ),
  },
  TAVILY_MAP: {
    operation: "read",
    inputSchema: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        instructions: { type: "string" },
        max_depth: { type: "number" },
        max_breadth: { type: "number" },
        limit: { type: "number" },
        select_paths: { type: "array", items: { type: "string" } },
        exclude_paths: { type: "array", items: { type: "string" } },
        allow_external: { type: "boolean" },
      },
      ["url"],
      false,
    ),
  },
  TAVILY_CRAWL: {
    operation: "write",
    inputSchema: objectSchema(
      {
        url: { type: "string", minLength: 1 },
        instructions: { type: "string" },
        max_depth: { type: "number" },
        max_breadth: { type: "number" },
        limit: { type: "number" },
        select_paths: { type: "array", items: { type: "string" } },
        exclude_paths: { type: "array", items: { type: "string" } },
        allow_external: { type: "boolean" },
        extract_depth: { type: "string" },
        format: { type: "string" },
      },
      ["url"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const PERPLEXITY_ACTIONS = {
  PERPLEXITYAI_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        max_results: { type: "number" },
        max_tokens_per_page: { type: "number" },
        country: { type: "string" },
        search_domain_filter: { type: "array", items: { type: "string" } },
      },
      ["query"],
      false,
    ),
  },
  PERPLEXITYAI_CREATE_CHAT_COMPLETION: {
    operation: "read",
    inputSchema: objectSchema(
      {
        model: { type: "string", minLength: 1 },
        messages: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              role: {
                type: "string",
                enum: ["system", "user", "assistant"],
              },
              content: {
                oneOf: [{ type: "string" }, { type: "array", minItems: 1 }],
              },
            },
            ["role", "content"],
            false,
          ),
        },
        max_tokens: { type: "number" },
        temperature: { type: "number" },
        top_p: { type: "number" },
        search_domain_filter: { type: "array", items: { type: "string" } },
        return_images: { type: "boolean" },
        return_related_questions: { type: "boolean" },
        search_recency_filter: { type: "string" },
        stream: { type: "boolean" },
      },
      ["model", "messages"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const POSTHOG_ACTIONS = {
  POSTHOG_LIST_PROJECTS: {
    operation: "read",
    inputSchema: objectSchema({}, [], false),
  },
  POSTHOG_GET_INSIGHTS: {
    operation: "read",
    inputSchema: objectSchema(
      {
        project_id: { type: ["string", "number"] },
        limit: { type: "number" },
        offset: { type: "number" },
        short_id: { type: "string" },
        search: { type: "string" },
      },
      ["project_id"],
      false,
    ),
  },
  POSTHOG_LIST_FEATURE_FLAGS: {
    operation: "read",
    inputSchema: objectSchema(
      {
        project_id: { type: ["string", "number"] },
        limit: { type: "number" },
        offset: { type: "number" },
        search: { type: "string" },
      },
      ["project_id"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const ABLY_ACTIONS = {
  ABLY_GET_CHANNEL_HISTORY: {
    operation: "read",
    inputSchema: objectSchema(
      {
        channel: { type: "string", minLength: 1 },
        start: { type: ["string", "number"] },
        end: { type: ["string", "number"] },
        direction: { type: "string" },
        limit: { type: "number" },
      },
      ["channel"],
      false,
    ),
  },
  ABLY_LIST_CHANNELS: {
    operation: "read",
    inputSchema: objectSchema(
      {
        limit: { type: "number" },
        prefix: { type: "string" },
        by: { type: "string" },
      },
      [],
      false,
    ),
  },
  ABLY_GET_STATS: {
    operation: "read",
    inputSchema: objectSchema(
      {
        start: { type: ["string", "number"] },
        end: { type: ["string", "number"] },
        direction: { type: "string" },
        limit: { type: "number" },
        unit: { type: "string" },
      },
      [],
      false,
    ),
  },
  ABLY_PUBLISH_MESSAGE: {
    operation: "write",
    inputSchema: objectSchema(
      {
        channel: { type: "string", minLength: 1 },
        name: { type: "string" },
        data: {},
        clientId: { type: "string" },
        extras: { type: "object" },
      },
      ["channel"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const ABUSEIPDB_ACTIONS = {
  ABUSEIPDB_CHECK_IP: {
    operation: "read",
    inputSchema: objectSchema(
      {
        ipAddress: { type: "string", minLength: 1 },
        maxAgeInDays: { type: "number" },
        verbose: { type: "boolean" },
      },
      ["ipAddress"],
      false,
    ),
  },
  ABUSEIPDB_GET_BLACKLIST: {
    operation: "read",
    inputSchema: objectSchema(
      {
        confidenceMinimum: { type: "number" },
        limit: { type: "number" },
        onlyCountries: { type: "string" },
        exceptCountries: { type: "string" },
        ipVersion: { type: "number" },
      },
      [],
      false,
    ),
  },
  ABUSEIPDB_CHECK_BLOCK: {
    operation: "read",
    inputSchema: objectSchema(
      {
        network: { type: "string", minLength: 1 },
        maxAgeInDays: { type: "number" },
      },
      ["network"],
      false,
    ),
  },
  ABUSEIPDB_REPORT_IP: {
    operation: "write",
    inputSchema: objectSchema(
      {
        ip: { type: "string", minLength: 1 },
        categories: { type: "string", minLength: 1 },
        comment: { type: "string" },
      },
      ["ip", "categories"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const PEOPLE_DATA_LABS_ACTIONS = {
  PEOPLEDATALABS_ENRICH_PERSON_DATA: {
    operation: "read",
    inputSchema: {
      ...objectSchema(
        {
          email: { type: "string" },
          phone: { type: "string" },
          profile: { type: "string" },
          lid: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          name: { type: "string" },
          company: { type: "string" },
          school: { type: "string" },
          location: { type: "string" },
          min_likelihood: { type: "number" },
          required: { type: "string" },
          pretty: { type: "boolean" },
        },
        [],
        false,
      ),
      anyOf: [
        { required: ["email"] },
        { required: ["phone"] },
        { required: ["profile"] },
        { required: ["lid"] },
        { required: ["name"] },
        { required: ["first_name", "last_name"] },
      ],
    },
  },
  PEOPLEDATALABS_PEOPLE_SEARCH_ELASTIC: {
    operation: "read",
    inputSchema: {
      ...objectSchema(
        {
          query: { type: "object" },
          sql: { type: "string" },
          size: { type: "number" },
          from: { type: "number" },
          dataset: { type: "string" },
          titlecase: { type: "boolean" },
          pretty: { type: "boolean" },
        },
        [],
        false,
      ),
      anyOf: [{ required: ["query"] }, { required: ["sql"] }],
    },
  },
  PEOPLEDATALABS_ENRICH_COMPANY_DATA: {
    operation: "read",
    inputSchema: {
      ...objectSchema(
        {
          website: { type: "string" },
          name: { type: "string" },
          profile: { type: "string" },
          ticker: { type: "string" },
          location: { type: "string" },
          min_likelihood: { type: "number" },
          required: { type: "string" },
          pretty: { type: "boolean" },
        },
        [],
        false,
      ),
      anyOf: [
        { required: ["website"] },
        { required: ["name"] },
        { required: ["profile"] },
        { required: ["ticker"] },
      ],
    },
  },
  PEOPLEDATALABS_SEARCH_COMPANY_ELASTIC: {
    operation: "read",
    inputSchema: {
      ...objectSchema(
        {
          query: { type: "object" },
          sql: { type: "string" },
          size: { type: "number" },
          from: { type: "number" },
          pretty: { type: "boolean" },
        },
        [],
        false,
      ),
      anyOf: [{ required: ["query"] }, { required: ["sql"] }],
    },
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

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

const APOLLO_ACTIONS = {
  APOLLO_PEOPLE_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
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
            enum: ["verified", "unverified", "likely to engage", "unavailable"],
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
      [],
      false,
    ),
  },
  APOLLO_ORGANIZATION_SEARCH: {
    operation: "read",
    inputSchema: objectSchema(
      {
        page: { type: "integer", minimum: 1, maximum: 500 },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
        organization_ids: { type: "array", items: { type: "string" } },
        q_organization_name: { type: "string" },
        organization_locations: { type: "array", items: { type: "string" } },
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
      [],
      false,
    ),
  },
  APOLLO_PEOPLE_ENRICH: {
    operation: "read",
    inputSchema: {
      ...objectSchema(
        {
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
        [],
        false,
      ),
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
  },
  APOLLO_CREATE_CONTACT: {
    operation: "write",
    inputSchema: objectSchema(
      {
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
      ["first_name", "last_name"],
      false,
    ),
  },
  APOLLO_CREATE_TASK: {
    operation: "write",
    inputSchema: objectSchema(
      {
        note: { type: "string" },
        type: { enum: APOLLO_TASK_TYPES },
        title: { type: "string" },
        due_at: { type: "string", minLength: 1 },
        status: { enum: APOLLO_TASK_STATUSES },
        user_id: { type: "string", minLength: 1 },
        priority: { enum: APOLLO_TASK_PRIORITIES },
        contact_id: { type: "string", minLength: 1 },
      },
      ["user_id", "contact_id", "type", "status", "due_at"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const TWOCHAT_ACTIONS = {
  TWOCHAT_GET_INFO: {
    operation: "read",
    inputSchema: objectSchema({}, [], false),
  },
  TWOCHAT_LIST_WHATSAPP_NUMBERS: {
    operation: "read",
    inputSchema: objectSchema({ page_number: { type: "number" } }, [], false),
  },
  TWOCHAT_SEND_WHATSAPP_MESSAGE: {
    operation: "write",
    inputSchema: objectSchema(
      {
        to_number: { type: "string", minLength: 1 },
        from_number: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
      },
      ["to_number", "from_number", "text"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const SEVENSHIFTS_ACTIONS = {
  SEVENSHIFTS_WHOAMI: {
    operation: "read",
    inputSchema: objectSchema({}, [], false),
  },
  SEVENSHIFTS_LIST_USERS: {
    operation: "read",
    inputSchema: objectSchema(
      {
        companyId: { type: ["string", "number"] },
        limit: { type: "number" },
        cursor: { type: "string" },
        status: { type: "string" },
      },
      ["companyId"],
      false,
    ),
  },
  SEVENSHIFTS_LIST_SHIFTS: {
    operation: "read",
    inputSchema: objectSchema(
      {
        companyId: { type: ["string", "number"] },
        limit: { type: "number" },
        cursor: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        location_id: { type: ["string", "number"] },
      },
      ["companyId"],
      false,
    ),
  },
  SEVENSHIFTS_CREATE_SHIFT: {
    operation: "write",
    inputSchema: objectSchema(
      {
        companyId: { type: ["string", "number"] },
        location_id: { type: ["string", "number"] },
        user_id: { type: ["string", "number"] },
        start: { type: "string", minLength: 1 },
        end: { type: "string", minLength: 1 },
      },
      ["companyId", "location_id", "user_id", "start", "end"],
      false,
    ),
  },
  "7SHIFTS_LIST_SHIFTS": {
    operation: "read",
    inputSchema: objectSchema(
      {
        company_id: { type: ["string", "number"] },
        location_id: { type: ["string", "number"] },
        department_id: { type: ["string", "number"] },
        role_id: { type: ["string", "number"] },
        user_id: { type: ["string", "number"] },
        start: { type: "string" },
        end: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
        status: { type: "string" },
      },
      ["company_id"],
      false,
    ),
  },
  "7SHIFTS_CREATE_DEPARTMENT": {
    operation: "write",
    inputSchema: objectSchema(
      {
        company_id: { type: ["string", "number"] },
        location_id: { type: ["string", "number"] },
        name: { type: "string", minLength: 1 },
        default: { type: "boolean" },
      },
      ["company_id", "location_id", "name", "default"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const ABYSSALE_ACTIONS = {
  ABYSSALE_LIST_TEMPLATES: {
    operation: "read",
    inputSchema: objectSchema({}, [], false),
  },
  ABYSSALE_GET_TEMPLATE: {
    operation: "read",
    inputSchema: objectSchema(
      { templateId: { type: "string", minLength: 1 } },
      ["templateId"],
      false,
    ),
  },
  ABYSSALE_GENERATE_IMAGE: {
    operation: "write",
    inputSchema: objectSchema(
      {
        templateId: { type: "string", minLength: 1 },
        elements: { type: "object" },
      },
      ["templateId"],
      false,
    ),
  },
  ABYSSALE_GENERATE_IMAGE_ASYNC: {
    operation: "write",
    inputSchema: objectSchema(
      {
        templateId: { type: "string", minLength: 1 },
        elements: { type: "object" },
      },
      ["templateId"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const ZEROCODEKIT_ACTIONS = {
  ZEROCODEKIT_PDF_METADATA: {
    operation: "read",
    inputSchema: {
      ...objectSchema(
        {
          url: { type: "string", minLength: 1 },
          buffer: { type: "string", minLength: 1 },
        },
        [],
        false,
      ),
      anyOf: [{ required: ["url"] }, { required: ["buffer"] }],
    },
  },
  ZEROCODEKIT_HTML_TO_PDF: {
    operation: "write",
    inputSchema: {
      ...objectSchema(
        {
          html: { type: "string", minLength: 1 },
          url: { type: "string", minLength: 1 },
          getAsUrl: { type: "boolean" },
          fileName: { type: "string", minLength: 1 },
          options: objectSchema(
            {
              scale: { type: "number", minimum: 0.1, maximum: 2 },
              displayHeaderFooter: { type: "boolean" },
              printBackground: { type: "boolean" },
              landscape: { type: "boolean" },
              pageRanges: { type: "string" },
              format: {
                type: "string",
                enum: [
                  "letter",
                  "Letter",
                  "LETTER",
                  "legal",
                  "Legal",
                  "LEGAL",
                  "tabloid",
                  "Tabloid",
                  "TABLOID",
                  "ledger",
                  "Ledger",
                  "LEDGER",
                  "a0",
                  "A0",
                  "a1",
                  "A1",
                  "a2",
                  "A2",
                  "a3",
                  "A3",
                  "a4",
                  "A4",
                  "a5",
                  "A5",
                  "a6",
                  "A6",
                ],
              },
              width: { anyOf: [{ type: "string" }, { type: "number" }] },
              height: { anyOf: [{ type: "string" }, { type: "number" }] },
              preferCSSPageSize: { type: "boolean" },
              margin: objectSchema(
                Object.fromEntries(
                  ["top", "bottom", "left", "right"].map((side) => [
                    side,
                    { anyOf: [{ type: "number" }, { type: "string" }] },
                  ]),
                ),
                [],
                false,
              ),
              omitBackground: { type: "boolean" },
              tagged: { type: "boolean" },
            },
            [],
            false,
          ),
        },
        [],
        false,
      ),
      anyOf: [{ required: ["html"] }, { required: ["url"] }],
    },
  },
  ZEROCODEKIT_MERGE_PDF: {
    operation: "write",
    inputSchema: objectSchema(
      {
        files: {
          type: "array",
          minItems: 1,
          items: {
            ...objectSchema(
              {
                url: { type: "string", minLength: 1 },
                buffer: { type: "string", minLength: 1 },
                pages: {
                  anyOf: [
                    { type: "array", items: { type: "number" } },
                    { type: "string" },
                  ],
                },
              },
              [],
              false,
            ),
            anyOf: [{ required: ["url"] }, { required: ["buffer"] }],
          },
        },
        getAsUrl: { type: "boolean" },
        fileName: { type: "string", minLength: 1 },
      },
      ["files"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

const FORTYFOUR_API_ACTIONS = {
  "44API_VALIDATE_VAT_NUMBER": {
    operation: "read",
    inputSchema: objectSchema(
      {
        vatNumber: { type: "string", minLength: 1 },
        countryCode: { type: "string", minLength: 2, maxLength: 2 },
      },
      ["vatNumber", "countryCode"],
      false,
    ),
  },
  "44API_LIST_WHITELISTED_IPS": {
    operation: "read",
    inputSchema: objectSchema({}, [], false),
  },
  "44API_ADD_WHITELISTED_IP": {
    operation: "write",
    inputSchema: objectSchema(
      {
        ipAddress: { type: "string", minLength: 1 },
        email: { type: "string", minLength: 1 },
      },
      ["ipAddress", "email"],
      false,
    ),
  },
  "44API_REMOVE_WHITELISTED_IP": {
    operation: "write",
    inputSchema: objectSchema(
      { ipAddress: { type: "string", minLength: 1 } },
      ["ipAddress"],
      false,
    ),
  },
} as const satisfies Readonly<Record<string, ApiKeyActionDescriptor>>;

/**
 * This is deliberately a reviewed activation set, not an open provider
 * registry. Every origin and credential placement is compiled into backend
 * code. The larger planner catalog remains deferred until a descriptor and
 * representative provider verification are added here.
 */
export const API_KEY_PROVIDER_DESCRIPTORS = [
  {
    connectorId: "firecrawl",
    providerKey: "firecrawl",
    displayName: "Firecrawl",
    credentialLabel: "Firecrawl API key",
    apiOrigin: "https://api.firecrawl.dev",
    auth: { type: "bearer" },
    actions: FIRECRAWL_ACTIONS,
  },
  {
    connectorId: "exa",
    providerKey: "exa",
    displayName: "Exa",
    credentialLabel: "Exa API key",
    apiOrigin: "https://api.exa.ai",
    auth: { type: "header", headerName: "x-api-key" },
    actions: EXA_ACTIONS,
  },
  {
    connectorId: "serpapi",
    providerKey: "serpapi",
    displayName: "SerpAPI",
    credentialLabel: "SerpAPI key",
    apiOrigin: "https://serpapi.com",
    auth: { type: "query", queryParam: "api_key" },
    actions: SERPAPI_ACTIONS,
  },
  {
    connectorId: "ashby",
    providerKey: "ashby",
    displayName: "Ashby",
    credentialLabel: "Ashby API key",
    apiOrigin: "https://api.ashbyhq.com",
    auth: { type: "basic", format: "username_empty_password" },
    actions: ASHBY_ACTIONS,
  },
  {
    connectorId: "tavily",
    providerKey: "tavily",
    displayName: "Tavily",
    credentialLabel: "Tavily API key",
    apiOrigin: "https://api.tavily.com",
    auth: { type: "bearer" },
    actions: TAVILY_ACTIONS,
  },
  {
    connectorId: "perplexityai",
    providerKey: "perplexityai",
    displayName: "Perplexity AI",
    credentialLabel: "Perplexity API key",
    apiOrigin: "https://api.perplexity.ai",
    auth: { type: "bearer" },
    actions: PERPLEXITY_ACTIONS,
  },
  {
    connectorId: "posthog",
    providerKey: "posthog",
    displayName: "PostHog (US Cloud)",
    credentialLabel: "PostHog US Cloud personal API key",
    apiOrigin: "https://us.posthog.com",
    auth: { type: "bearer" },
    actions: POSTHOG_ACTIONS,
  },
  {
    connectorId: "ably",
    providerKey: "ably",
    displayName: "Ably",
    credentialLabel: "Ably API key",
    apiOrigin: "https://rest.ably.io",
    auth: { type: "basic", format: "credentials_pair" },
    actions: ABLY_ACTIONS,
  },
  {
    connectorId: "abuseipdb",
    providerKey: "abuseipdb",
    displayName: "AbuseIPDB",
    credentialLabel: "AbuseIPDB API key",
    apiOrigin: "https://api.abuseipdb.com",
    auth: { type: "header", headerName: "Key" },
    actions: ABUSEIPDB_ACTIONS,
  },
  {
    connectorId: "peopledatalabs",
    providerKey: "peopledatalabs",
    displayName: "People Data Labs",
    credentialLabel: "People Data Labs API key",
    apiOrigin: "https://api.peopledatalabs.com",
    auth: { type: "header", headerName: "X-Api-Key" },
    actions: PEOPLE_DATA_LABS_ACTIONS,
  },
  {
    connectorId: "apollo",
    providerKey: "apollo",
    displayName: "Apollo",
    credentialLabel: "Apollo API key",
    apiOrigin: "https://api.apollo.io",
    auth: { type: "header", headerName: "X-Api-Key" },
    actions: APOLLO_ACTIONS,
  },
  {
    connectorId: "2chat",
    providerKey: "2chat",
    displayName: "2Chat",
    credentialLabel: "2Chat user API key",
    apiOrigin: "https://api.p.2chat.io",
    auth: { type: "header", headerName: "X-User-API-Key" },
    actions: TWOCHAT_ACTIONS,
  },
  {
    connectorId: "7shifts",
    providerKey: "7shifts",
    displayName: "7shifts",
    credentialLabel: "7shifts access token",
    apiOrigin: "https://api.7shifts.com",
    auth: { type: "bearer" },
    actions: SEVENSHIFTS_ACTIONS,
  },
  {
    connectorId: "abyssale",
    providerKey: "abyssale",
    displayName: "Abyssale",
    credentialLabel: "Abyssale API key",
    apiOrigin: "https://api.abyssale.com",
    auth: { type: "header", headerName: "x-api-key" },
    actions: ABYSSALE_ACTIONS,
  },
  {
    connectorId: "0codekit",
    providerKey: "0codekit",
    displayName: "0CodeKit",
    credentialLabel: "0CodeKit API key",
    apiOrigin: "https://prod.0codekit.com",
    auth: { type: "header", headerName: "auth" },
    actions: ZEROCODEKIT_ACTIONS,
  },
  {
    connectorId: "44api",
    providerKey: "44api",
    displayName: "44API",
    credentialLabel: "44API API key",
    apiOrigin: "https://api.44api.dev",
    auth: { type: "header", headerName: "X-API-Key" },
    actions: FORTYFOUR_API_ACTIONS,
  },
] as const satisfies readonly ApiKeyProviderDescriptor[];

const descriptorByConnector = new Map<string, ApiKeyProviderDescriptor>(
  API_KEY_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.connectorId,
    descriptor as ApiKeyProviderDescriptor,
  ]),
);
const descriptorByProvider = new Map<string, ApiKeyProviderDescriptor>(
  API_KEY_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.providerKey,
    descriptor as ApiKeyProviderDescriptor,
  ]),
);

export const getApiKeyProviderDescriptor = (
  connectorId: string,
): ApiKeyProviderDescriptor | null =>
  descriptorByConnector.get(connectorId.trim().toLowerCase()) ?? null;

export const getApiKeyProviderDescriptorByKey = (
  providerKey: string,
): ApiKeyProviderDescriptor | null =>
  descriptorByProvider.get(providerKey.trim().toLowerCase()) ?? null;

const descriptorActionName = (providerKey: string, action: string): string => {
  if (providerKey === "44api" && action.startsWith("FORTYFOUR_API_")) {
    return action.replace(/^FORTYFOUR_API_/u, "44API_");
  }
  return action;
};

export const getApiKeyActionDescriptor = (
  descriptor: ApiKeyProviderDescriptor,
  action: string,
): ApiKeyActionDescriptor | null =>
  descriptor.actions[descriptorActionName(descriptor.providerKey, action)] ??
  null;

export const apiKeyProviderForConnectorAction = (
  connectorId: string,
  action: string,
): ApiKeyProviderDescriptor | null => {
  const descriptor = getApiKeyProviderDescriptor(connectorId);
  return descriptor && getApiKeyActionDescriptor(descriptor, action)
    ? descriptor
    : null;
};

export const validateApiKeyCredential = (
  value: string,
  auth?: ApiKeyAuthPlacement,
): string => {
  if (
    value.length < 8 ||
    value.length > 1024 ||
    value !== value.trim() ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    (auth?.type === "basic" &&
      (auth.format === "username_empty_password"
        ? value.includes(":")
        : !/^[^:]+:[^:]+$/u.test(value)))
  ) {
    throw new ConnectorError("invalid_credential");
  }
  return value;
};

export const isApiKeyProviderVerified = (providerKey: string): boolean => {
  const raw = process.env.STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS;
  if (!raw) return false;
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(providerKey.trim().toLowerCase());
};

export const requireReadyApiKeyProvider = (
  connectorId: string,
): ApiKeyProviderDescriptor => {
  const descriptor = getApiKeyProviderDescriptor(connectorId);
  if (!descriptor) throw new ConnectorError("provider_not_configured");
  if (!isApiKeyProviderVerified(descriptor.providerKey)) {
    throw new ConnectorError("provider_unverified");
  }
  if (!isProviderEnabled(descriptor.providerKey)) {
    throw new ConnectorError("provider_disabled");
  }
  return descriptor;
};

export const buildDescriptorRequest = (
  descriptor: ApiKeyProviderDescriptor,
  action: string,
  input: Record<string, unknown>,
): ApiKeyProviderRequest => {
  if (!getApiKeyActionDescriptor(descriptor, action)) {
    throw new ConnectorError("action_not_found");
  }
  const request = buildApiKeyProviderRequest(
    descriptor.providerKey,
    action,
    input,
  );
  if (!request) throw new ConnectorError("action_not_found");
  return request;
};

export const validateApiKeyProviderDescriptors = (): string[] => {
  const problems: string[] = [];
  const connectorIds = new Set<string>();
  const providerKeys = new Set<string>();
  const deferredByConnector = new Map(
    DEFERRED_API_KEY_PROVIDERS.map((provider) => [
      provider.connectorId,
      provider,
    ]),
  );
  for (const descriptor of API_KEY_PROVIDER_DESCRIPTORS) {
    if (connectorIds.has(descriptor.connectorId)) {
      problems.push(`duplicate connector ${descriptor.connectorId}`);
    }
    if (providerKeys.has(descriptor.providerKey)) {
      problems.push(`duplicate provider ${descriptor.providerKey}`);
    }
    connectorIds.add(descriptor.connectorId);
    providerKeys.add(descriptor.providerKey);
    const deferred = deferredByConnector.get(descriptor.connectorId);
    if (
      !deferred ||
      deferred.providerKey !== descriptor.providerKey ||
      deferred.fixedApiOrigin !== descriptor.apiOrigin
    ) {
      problems.push(
        `${descriptor.connectorId} does not match the planner catalog`,
      );
    }
    try {
      const origin = new URL(descriptor.apiOrigin);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== descriptor.apiOrigin ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      ) {
        problems.push(
          `${descriptor.connectorId} origin is not a fixed HTTPS origin`,
        );
      }
    } catch {
      problems.push(`${descriptor.connectorId} origin is invalid`);
    }
    for (const [action, actionDescriptor] of Object.entries(
      descriptor.actions,
    )) {
      const canonicalAction = canonicalizeDeferredActionName(
        descriptor.providerKey,
        action,
      );
      if (deferred?.actions[canonicalAction] !== actionDescriptor.operation) {
        problems.push(`${descriptor.connectorId}:${action} operation mismatch`);
      }
      if (
        !/^[A-Z][A-Z0-9_]*$/u.test(action) &&
        !(
          descriptor.providerKey === "44api" &&
          /^44API_[A-Z0-9_]+$/u.test(action)
        ) &&
        !(
          descriptor.providerKey === "7shifts" &&
          /^7SHIFTS_[A-Z0-9_]+$/u.test(action)
        )
      ) {
        problems.push(`${descriptor.connectorId}:${action} has an unsafe name`);
      }
      if (actionDescriptor.inputSchema.type !== "object") {
        problems.push(
          `${descriptor.connectorId}:${action} has no object schema`,
        );
      }
    }
  }
  return problems;
};
