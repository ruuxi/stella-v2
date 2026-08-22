import { ConnectorError } from "../errors";

export type ProductivityProviderRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

type Operation = "read" | "write" | "destructive";

const requiredString = (
  input: Record<string, unknown>,
  ...keys: string[]
): string => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  throw new ConnectorError("invalid_input");
};

const optionalString = (
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const requiredRecord = (
  input: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> => {
  for (const key of keys) {
    const value = input[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  throw new ConnectorError("invalid_input");
};

const requiredArray = (
  input: Record<string, unknown>,
  key: string,
): unknown[] => {
  const value = input[key];
  if (Array.isArray(value) && value.length > 0) return value;
  throw new ConnectorError("invalid_input");
};

const selectedBody = (
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    keys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );

const jiraDocument = (value: unknown): unknown => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: value }],
      },
    ],
  };
};

const withQuery = (
  path: string,
  input: Record<string, unknown>,
  allowed: readonly string[],
): string => {
  const url = new URL(path, "https://request.invalid");
  for (const key of allowed) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      url.searchParams.set(key, String(value));
    } else if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      for (const entry of value) url.searchParams.append(`${key}[]`, entry);
    }
  }
  return `${url.pathname}${url.search}`;
};

export const PRODUCTIVITY_ACTION_OPERATIONS: Readonly<
  Record<string, Readonly<Record<string, Operation>>>
> = {
  notion: {
    NOTION_SEARCH_NOTION_PAGE: "read",
    NOTION_CREATE_NOTION_PAGE: "write",
  },
  slack: {
    SLACK_FETCH_CONVERSATION_HISTORY: "read",
    SLACK_SEND_MESSAGE: "write",
    SLACKBOT_FIND_CHANNELS: "read",
    SLACKBOT_SEND_MESSAGE: "write",
  },
  airtable: {
    AIRTABLE_LIST_RECORDS: "read",
    AIRTABLE_CREATE_RECORDS: "write",
  },
  asana: {
    ASANA_GET_MULTIPLE_TASKS: "read",
    ASANA_CREATE_A_TASK: "write",
  },
  clickup: {
    CLICKUP_GET_TASKS: "read",
    CLICKUP_CREATE_TASK: "write",
  },
  monday: {
    MONDAY_BOARDS: "read",
    MONDAY_CREATE_ITEM: "write",
  },
  linear: {
    LINEAR_LIST_LINEAR_ISSUES: "read",
    LINEAR_CREATE_LINEAR_ISSUE: "write",
  },
  atlassian: {
    JIRA_GET_ISSUE: "read",
    JIRA_CREATE_ISSUE: "write",
  },
  canvas: {
    CANVAS_LIST_COURSES: "read",
    CANVAS_CREATE_COURSE: "write",
  },
  "7shifts": {
    "7SHIFTS_LIST_SHIFTS": "read",
    "7SHIFTS_CREATE_DEPARTMENT": "write",
  },
};

export const PRODUCTIVITY_ACTION_REQUIRED_SCOPES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  notion: {
    NOTION_SEARCH_NOTION_PAGE: ["integration:configured"],
    NOTION_CREATE_NOTION_PAGE: ["integration:configured"],
  },
  slack: {
    SLACK_FETCH_CONVERSATION_HISTORY: ["channels:history"],
    SLACK_SEND_MESSAGE: ["chat:write"],
    SLACKBOT_FIND_CHANNELS: ["channels:read"],
    SLACKBOT_SEND_MESSAGE: ["chat:write"],
  },
  airtable: {
    AIRTABLE_LIST_RECORDS: ["data.records:read"],
    AIRTABLE_CREATE_RECORDS: ["data.records:write"],
  },
  asana: {
    ASANA_GET_MULTIPLE_TASKS: ["default"],
    ASANA_CREATE_A_TASK: ["default"],
  },
  clickup: {
    CLICKUP_GET_TASKS: ["workspace:configured"],
    CLICKUP_CREATE_TASK: ["workspace:configured"],
  },
  monday: {
    MONDAY_BOARDS: ["boards:read"],
    MONDAY_CREATE_ITEM: ["boards:write"],
  },
  linear: {
    LINEAR_LIST_LINEAR_ISSUES: ["read"],
    LINEAR_CREATE_LINEAR_ISSUE: ["write"],
  },
  atlassian: {
    JIRA_GET_ISSUE: ["read:jira-work"],
    JIRA_CREATE_ISSUE: ["write:jira-work"],
  },
  canvas: {
    CANVAS_LIST_COURSES: ["url:GET|/api/v1/courses"],
    CANVAS_CREATE_COURSE: ["url:POST|/api/v1/accounts/:account_id/courses"],
  },
  "7shifts": {
    "7SHIFTS_LIST_SHIFTS": [],
    "7SHIFTS_CREATE_DEPARTMENT": [],
  },
};

export const PRODUCTIVITY_PROVIDER_CONNECTOR_ACTIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  notion: {
    notion: ["NOTION_SEARCH_NOTION_PAGE", "NOTION_CREATE_NOTION_PAGE"],
  },
  slack: {
    slack: ["SLACK_FETCH_CONVERSATION_HISTORY", "SLACK_SEND_MESSAGE"],
    slackbot: ["SLACKBOT_FIND_CHANNELS", "SLACKBOT_SEND_MESSAGE"],
  },
  airtable: {
    airtable: ["AIRTABLE_LIST_RECORDS", "AIRTABLE_CREATE_RECORDS"],
  },
  asana: {
    asana: ["ASANA_GET_MULTIPLE_TASKS", "ASANA_CREATE_A_TASK"],
  },
  clickup: {
    clickup: ["CLICKUP_GET_TASKS", "CLICKUP_CREATE_TASK"],
  },
  monday: {
    monday: ["MONDAY_BOARDS", "MONDAY_CREATE_ITEM"],
  },
  linear: {
    linear: ["LINEAR_LIST_LINEAR_ISSUES", "LINEAR_CREATE_LINEAR_ISSUE"],
  },
  atlassian: {
    jira: ["JIRA_GET_ISSUE", "JIRA_CREATE_ISSUE"],
  },
  canvas: {
    canvas: ["CANVAS_LIST_COURSES", "CANVAS_CREATE_COURSE"],
  },
  "7shifts": {
    "7shifts": ["7SHIFTS_LIST_SHIFTS", "7SHIFTS_CREATE_DEPARTMENT"],
  },
};

const notionRequest = (
  action: string,
  input: Record<string, unknown>,
): ProductivityProviderRequest | null => {
  const headers = { "notion-version": "2022-06-28" };
  if (action === "NOTION_SEARCH_NOTION_PAGE") {
    const body = selectedBody(input, ["query", "page_size", "start_cursor"]);
    const direction = optionalString(input, "direction");
    const timestamp = optionalString(input, "timestamp");
    if (direction || timestamp) {
      body.sort = {
        direction: direction ?? "descending",
        timestamp: timestamp ?? "last_edited_time",
      };
    }
    const filterProperty = optionalString(input, "filter_property");
    const filterValue = optionalString(input, "filter_value");
    if (filterProperty || filterValue) {
      if (!filterProperty || !filterValue)
        throw new ConnectorError("invalid_input");
      body.filter = { property: filterProperty, value: filterValue };
    }
    const path = withQuery("/v1/search", input, [
      "filter_properties",
    ]).replaceAll("filter_properties%5B%5D=", "filter_properties=");
    return { method: "POST", path, body, headers };
  }
  if (action === "NOTION_CREATE_NOTION_PAGE") {
    const parentId = requiredString(input, "parent_id");
    const title = requiredString(input, "title");
    const markdown = optionalString(input, "markdown");
    if (title.length > 2_000 || (markdown?.length ?? 0) > 2_000) {
      throw new ConnectorError("invalid_input");
    }
    return {
      method: "POST",
      path: "/v1/pages",
      headers,
      body: {
        parent: { page_id: parentId },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
        ...(optionalString(input, "icon")
          ? {
              icon: { type: "emoji", emoji: optionalString(input, "icon") },
            }
          : {}),
        ...(optionalString(input, "cover")
          ? {
              cover: {
                type: "external",
                external: { url: optionalString(input, "cover") },
              },
            }
          : {}),
        ...(markdown
          ? {
              children: [
                {
                  object: "block",
                  type: "paragraph",
                  paragraph: {
                    rich_text: [{ type: "text", text: { content: markdown } }],
                  },
                },
              ],
            }
          : {}),
      },
    };
  }
  return null;
};

const graphQlRequest = (
  providerKey: string,
  action: string,
  input: Record<string, unknown>,
): ProductivityProviderRequest | null => {
  if (providerKey === "monday" && action === "MONDAY_BOARDS") {
    const limit =
      typeof input.limit === "number"
        ? Math.min(Math.max(input.limit, 1), 100)
        : 25;
    return {
      method: "POST",
      path: "/v2",
      body: {
        query:
          "query ($ids: [ID!], $page: Int, $limit: Int!, $state: State, $orderBy: BoardsOrderBy, $boardKind: BoardKind, $workspaceIds: [ID], $hierarchyTypes: [BoardHierarchy!]) { boards(ids: $ids, page: $page, limit: $limit, state: $state, order_by: $orderBy, board_kind: $boardKind, workspace_ids: $workspaceIds, hierarchy_types: $hierarchyTypes) { id name state } }",
        variables: {
          ids: input.ids ?? null,
          page: input.page ?? null,
          limit,
          state: input.state ?? null,
          orderBy: input.order_by ?? null,
          boardKind: input.board_kind ?? null,
          workspaceIds: input.workspace_ids ?? null,
          hierarchyTypes: input.hierarchy_type ?? null,
        },
      },
    };
  }
  if (providerKey === "monday" && action === "MONDAY_CREATE_ITEM") {
    const boardId = requiredString(input, "board_id", "boardId");
    const itemName = requiredString(input, "item_name", "itemName", "name");
    const groupId = optionalString(input, "group_id", "groupId");
    const columnValues = input.column_values ?? input.columnValues;
    if (
      columnValues !== undefined &&
      typeof columnValues !== "string" &&
      (typeof columnValues !== "object" || columnValues === null)
    ) {
      throw new ConnectorError("invalid_input");
    }
    return {
      method: "POST",
      path: "/v2",
      body: {
        query:
          "mutation ($board: ID!, $name: String!, $group: String, $columns: JSON) { create_item(board_id: $board, item_name: $name, group_id: $group, column_values: $columns) { id name } }",
        variables: {
          board: boardId,
          name: itemName,
          group: groupId,
          columns:
            columnValues !== undefined && typeof columnValues !== "string"
              ? JSON.stringify(columnValues)
              : columnValues,
        },
      },
    };
  }
  if (providerKey === "linear" && action === "LINEAR_LIST_LINEAR_ISSUES") {
    const first =
      typeof input.first === "number"
        ? Math.min(Math.max(input.first, 1), 250)
        : 25;
    const filter: Record<string, unknown> = {};
    const projectId = optionalString(input, "project_id", "projectId");
    const assigneeId = optionalString(input, "assignee_id", "assigneeId");
    if (projectId) filter.project = { id: { eq: projectId } };
    if (assigneeId) filter.assignee = { id: { eq: assigneeId } };
    return {
      method: "POST",
      path: "/graphql",
      body: {
        query:
          "query ($first: Int!, $after: String, $filter: IssueFilter) { issues(first: $first, after: $after, filter: $filter) { nodes { id identifier title state { id name } labels { nodes { id name } } } pageInfo { hasNextPage endCursor } } }",
        variables: {
          first,
          after: optionalString(input, "after") ?? null,
          filter: Object.keys(filter).length > 0 ? filter : null,
        },
      },
    };
  }
  if (providerKey === "linear" && action === "LINEAR_CREATE_LINEAR_ISSUE") {
    const issueInput: Record<string, unknown> = {
      teamId: requiredString(input, "team_id", "teamId"),
      title: requiredString(input, "title"),
      ...selectedBody(input, ["description", "priority", "estimate"]),
    };
    for (const [source, target] of [
      ["assignee_id", "assigneeId"],
      ["state_id", "stateId"],
      ["cycle_id", "cycleId"],
      ["project_id", "projectId"],
      ["parent_id", "parentId"],
      ["label_ids", "labelIds"],
      ["due_date", "dueDate"],
    ] as const) {
      if (input[source] !== undefined) issueInput[target] = input[source];
    }
    const variables = {
      input: issueInput,
    };
    return {
      method: "POST",
      path: "/graphql",
      body: {
        query:
          "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title } } }",
        variables,
      },
    };
  }
  return null;
};

export const buildProductivityProviderRequest = (
  providerKey: string,
  action: string,
  input: Record<string, unknown>,
): ProductivityProviderRequest | null => {
  if (providerKey === "notion") return notionRequest(action, input);
  const graphQl = graphQlRequest(providerKey, action, input);
  if (graphQl) return graphQl;

  switch (`${providerKey}:${action}`) {
    case "slack:SLACK_FETCH_CONVERSATION_HISTORY":
      return {
        method: "GET",
        path: withQuery("/api/conversations.history", input, [
          "channel",
          "cursor",
          "limit",
          "oldest",
          "latest",
          "inclusive",
        ]),
      };
    case "slack:SLACKBOT_FIND_CHANNELS":
      return {
        method: "GET",
        path: withQuery("/api/conversations.list", input, [
          "cursor",
          "limit",
          "types",
          "exclude_archived",
        ]),
      };
    case "slack:SLACK_SEND_MESSAGE":
    case "slack:SLACKBOT_SEND_MESSAGE": {
      const markdownText = optionalString(input, "markdown_text");
      const legacyText = optionalString(input, "text", "message");
      const blocks = input.blocks;
      if (blocks !== undefined && !Array.isArray(blocks))
        throw new ConnectorError("invalid_input");
      if ((markdownText || legacyText) && blocks)
        throw new ConnectorError("invalid_input");
      if (!markdownText && !legacyText && !blocks)
        throw new ConnectorError("invalid_input");
      return {
        method: "POST",
        path: "/api/chat.postMessage",
        body: {
          channel: requiredString(input, "channel", "channel_id"),
          ...(markdownText || legacyText
            ? { text: markdownText ?? legacyText }
            : {}),
          ...(blocks ? { blocks } : {}),
          ...(blocks && optionalString(input, "fallback_text")
            ? { text: optionalString(input, "fallback_text") }
            : {}),
          ...(optionalString(input, "thread_ts")
            ? { thread_ts: optionalString(input, "thread_ts") }
            : {}),
          ...selectedBody(input, [
            "unfurl_links",
            "unfurl_media",
            "reply_broadcast",
          ]),
        },
      };
    }

    case "airtable:AIRTABLE_LIST_RECORDS": {
      const base = encodeURIComponent(requiredString(input, "baseId"));
      const table = encodeURIComponent(requiredString(input, "tableIdOrName"));
      const queryInput: Record<string, unknown> = { ...input };
      delete queryInput.sort;
      return {
        method: "GET",
        path: (() => {
          const path = withQuery(`/v0/${base}/${table}`, queryInput, [
            "view",
            "offset",
            "pageSize",
            "maxRecords",
            "filterByFormula",
            "returnFieldsByFieldId",
            "fields",
            "recordMetadata",
            "cellFormat",
            "timeZone",
            "userLocale",
          ]);
          const url = new URL(path, "https://request.invalid");
          if (Array.isArray(input.sort)) {
            input.sort.forEach((value, index) => {
              const entry = requiredRecord({ value }, "value");
              url.searchParams.append(
                `sort[${index}][field]`,
                requiredString(entry, "field"),
              );
              const direction = optionalString(entry, "direction");
              if (direction)
                url.searchParams.append(`sort[${index}][direction]`, direction);
            });
          }
          return `${url.pathname}${url.search}`;
        })(),
      };
    }
    case "airtable:AIRTABLE_CREATE_RECORDS": {
      const base = encodeURIComponent(requiredString(input, "baseId"));
      const table = encodeURIComponent(requiredString(input, "tableIdOrName"));
      return {
        method: "POST",
        path: `/v0/${base}/${table}`,
        body: {
          records: requiredArray(input, "records"),
          ...(typeof input.typecast === "boolean"
            ? { typecast: input.typecast }
            : {}),
        },
      };
    }

    case "asana:ASANA_GET_MULTIPLE_TASKS":
      if (
        !optionalString(input, "project", "section", "tag", "user_task_list") &&
        !(
          optionalString(input, "assignee") &&
          optionalString(input, "workspace")
        )
      ) {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "GET",
        path: withQuery("/api/1.0/tasks", input, [
          "tag",
          "limit",
          "offset",
          "project",
          "section",
          "user_task_list",
          "assignee",
          "workspace",
          "opt_fields",
          "opt_pretty",
          "modified_since",
          "completed_since",
        ]),
      };
    case "asana:ASANA_CREATE_A_TASK":
      return {
        method: "POST",
        path: "/api/1.0/tasks",
        body: { data: requiredRecord(input, "data") },
      };

    case "clickup:CLICKUP_GET_TASKS": {
      const listId = encodeURIComponent(
        requiredString(input, "list_id", "listId"),
      );
      return {
        method: "GET",
        path: withQuery(`/api/v2/list/${listId}/task`, input, [
          "archived",
          "page",
          "order_by",
          "reverse",
          "subtasks",
          "statuses",
          "include_closed",
          "assignees",
          "due_date_gt",
          "due_date_lt",
        ]),
      };
    }
    case "clickup:CLICKUP_CREATE_TASK": {
      const listId = encodeURIComponent(
        requiredString(input, "list_id", "listId"),
      );
      const body = selectedBody(input, [
        "name",
        "tags",
        "parent",
        "status",
        "due_date",
        "links_to",
        "priority",
        "assignees",
        "start_date",
        "description",
        "custom_fields",
        "due_date_time",
        "time_estimate",
        "custom_item_id",
        "start_date_time",
        "check_required_custom_fields",
      ]);
      requiredString(body, "name");
      return {
        method: "POST",
        path: withQuery(`/api/v2/list/${listId}/task`, input, [
          "custom_task_ids",
          "team_id",
          "notify_all",
        ]),
        body,
      };
    }

    case "atlassian:JIRA_GET_ISSUE": {
      const cloudId = encodeURIComponent(
        requiredString(input, "cloudId", "cloud_id"),
      );
      const issue = encodeURIComponent(
        requiredString(input, "issueIdOrKey", "issue_id_or_key", "issue_key"),
      );
      return {
        method: "GET",
        path: withQuery(
          `/ex/jira/${cloudId}/rest/api/3/issue/${issue}`,
          input,
          ["fields", "expand", "properties", "updateHistory", "failFast"],
        ),
      };
    }
    case "atlassian:JIRA_CREATE_ISSUE": {
      const cloudId = encodeURIComponent(
        requiredString(input, "cloudId", "cloud_id"),
      );
      const issueType = requiredString(input, "issue_type");
      const fields: Record<string, unknown> = {};
      const additional = optionalString(input, "additional_properties");
      if (additional) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(additional);
        } catch {
          throw new ConnectorError("invalid_input");
        }
        const extraFields = requiredRecord({ parsed }, "parsed");
        for (const forbidden of [
          "__proto__",
          "constructor",
          "prototype",
          "resolution",
        ]) {
          delete extraFields[forbidden];
        }
        Object.assign(fields, extraFields);
      }
      Object.assign(fields, {
        project: { key: requiredString(input, "project_key") },
        summary: requiredString(input, "summary"),
        issuetype: /^\d+$/u.test(issueType)
          ? { id: issueType }
          : { name: issueType },
      });
      const description = jiraDocument(input.description);
      const environment = jiraDocument(input.environment);
      if (description) fields.description = description;
      if (environment) fields.environment = environment;
      if (Array.isArray(input.labels)) fields.labels = input.labels;
      if (Array.isArray(input.components)) {
        fields.components = input.components.map((id) => ({ id }));
      }
      if (Array.isArray(input.versions)) {
        fields.versions = input.versions.map((id) => ({ id }));
      }
      if (Array.isArray(input.fix_versions)) {
        fields.fixVersions = input.fix_versions.map((id) => ({ id }));
      }
      const assignee = optionalString(input, "assignee");
      const reporter = optionalString(input, "reporter");
      const priority = optionalString(input, "priority");
      const parent = optionalString(input, "parent", "parent_id", "parent_key");
      const dueDate = optionalString(input, "due_date");
      if (assignee) fields.assignee = { accountId: assignee };
      if (reporter) fields.reporter = { accountId: reporter };
      if (priority) {
        fields.priority = /^\d+$/u.test(priority)
          ? { id: priority }
          : { name: priority };
      }
      if (parent) fields.parent = { key: parent };
      if (dueDate) fields.duedate = dueDate;
      return {
        method: "POST",
        path: `/ex/jira/${cloudId}/rest/api/3/issue`,
        body: { fields },
      };
    }

    case "canvas:CANVAS_LIST_COURSES":
      return {
        method: "GET",
        path: withQuery("/api/v1/courses", input, [
          "enrollment_type",
          "enrollment_role",
          "enrollment_state",
          "state",
          "page",
          "per_page",
          "include",
        ]),
      };
    case "canvas:CANVAS_CREATE_COURSE": {
      const accountId = encodeURIComponent(
        requiredString(input, "account_id", "accountId"),
      );
      const course = selectedBody(input, [
        "name",
        "end_at",
        "license",
        "term_id",
        "start_at",
        "is_public",
        "time_zone",
        "course_code",
        "default_view",
        "course_format",
        "post_manually",
        "sis_course_id",
        "syllabus_body",
        "integration_id",
        "open_enrollment",
        "public_syllabus",
        "self_enrollment",
        "hide_final_grades",
        "public_description",
        "allow_wiki_comments",
        "grading_standard_id",
        "grade_passback_setting",
        "is_public_to_auth_users",
        "public_syllabus_to_auth",
        "allow_student_wiki_edits",
        "apply_assignment_group_weights",
        "allow_student_forum_attachments",
        "restrict_enrollments_to_course_dates",
      ]);
      return {
        method: "POST",
        path: `/api/v1/accounts/${accountId}/courses`,
        body: {
          course,
          ...selectedBody(input, [
            "offer",
            "enroll_me",
            "enable_sis_reactivation",
          ]),
        },
      };
    }

    case "7shifts:7SHIFTS_LIST_SHIFTS": {
      const companyId = encodeURIComponent(
        requiredString(input, "company_id", "companyId"),
      );
      return {
        method: "GET",
        path: withQuery(`/v2/company/${companyId}/shifts`, input, [
          "location_id",
          "department_id",
          "role_id",
          "user_id",
          "start",
          "end",
          "limit",
          "cursor",
          "status",
        ]),
        headers: { "x-api-version": "2026-01-01" },
      };
    }
    case "7shifts:7SHIFTS_CREATE_DEPARTMENT": {
      const companyId = encodeURIComponent(
        requiredString(input, "company_id", "companyId"),
      );
      if (
        (typeof input.location_id !== "string" &&
          typeof input.location_id !== "number") ||
        typeof input.default !== "boolean"
      ) {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "POST",
        path: `/v2/company/${companyId}/departments`,
        body: {
          location_id: input.location_id,
          name: requiredString(input, "name"),
          default: input.default,
        },
        headers: { "x-api-version": "2026-01-01" },
      };
    }
    default:
      return null;
  }
};
