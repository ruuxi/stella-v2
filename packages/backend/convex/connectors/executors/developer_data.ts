import { ConnectorError } from "../errors";

export type DeveloperDataProviderRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

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
    }
  }
  return `${url.pathname}${url.search}`;
};

const pick = (
  input: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    allowed
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );

const githubHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "Stella/1.0 (contact@fromyou.ai)",
};

export const DEVELOPER_DATA_ACTION_OPERATIONS: Readonly<
  Record<string, Readonly<Record<string, "read" | "write">>>
> = {
  github: {
    GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER: "read",
    GITHUB_GET_A_REPOSITORY: "read",
    GITHUB_SEARCH_REPOSITORIES: "read",
    GITHUB_LIST_PULL_REQUESTS: "read",
    GITHUB_SEARCH_ISSUES: "read",
    GITHUB_CREATE_AN_ISSUE: "write",
  },
  supabase: {
    SUPABASE_LIST_ALL_PROJECTS: "read",
    SUPABASE_GET_PROJECT: "read",
    SUPABASE_LIST_ALL_ORGANIZATIONS: "read",
    SUPABASE_CREATE_A_PROJECT: "write",
  },
};

export const DEVELOPER_DATA_ACTION_REQUIRED_SCOPES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  github: Object.fromEntries(
    Object.keys(DEVELOPER_DATA_ACTION_OPERATIONS.github).map((action) => [
      action,
      ["repo", "read:user", "user:email"],
    ]),
  ),
  supabase: Object.fromEntries(
    Object.keys(DEVELOPER_DATA_ACTION_OPERATIONS.supabase).map((action) => [
      action,
      ["all"],
    ]),
  ),
};

export const DEVELOPER_DATA_PROVIDER_CONNECTOR_ACTIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  github: {
    github: Object.keys(DEVELOPER_DATA_ACTION_OPERATIONS.github),
  },
  supabase: {
    supabase: Object.keys(DEVELOPER_DATA_ACTION_OPERATIONS.supabase),
  },
};

export const buildDeveloperDataProviderRequest = (
  providerKey: string,
  action: string,
  input: Record<string, unknown>,
): DeveloperDataProviderRequest | null => {
  switch (`${providerKey}:${action}`) {
    case "github:GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER":
      return {
        method: "GET",
        path: withQuery("/user/repos", input, [
          "visibility",
          "affiliation",
          "type",
          "sort",
          "direction",
          "per_page",
          "page",
          "since",
          "before",
        ]),
        headers: githubHeaders,
      };
    case "github:GITHUB_GET_A_REPOSITORY": {
      const owner = requiredString(input, "owner");
      const repo = requiredString(input, "repo");
      return {
        method: "GET",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        headers: githubHeaders,
      };
    }
    case "github:GITHUB_SEARCH_REPOSITORIES":
      requiredString(input, "q");
      return {
        method: "GET",
        path: withQuery("/search/repositories", input, [
          "q",
          "sort",
          "order",
          "per_page",
          "page",
        ]),
        headers: githubHeaders,
      };
    case "github:GITHUB_LIST_PULL_REQUESTS": {
      const owner = requiredString(input, "owner");
      const repo = requiredString(input, "repo");
      return {
        method: "GET",
        path: withQuery(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          input,
          ["state", "head", "base", "sort", "direction", "per_page", "page"],
        ),
        headers: githubHeaders,
      };
    }
    case "github:GITHUB_SEARCH_ISSUES":
      requiredString(input, "q");
      return {
        method: "GET",
        path: withQuery("/search/issues", input, [
          "q",
          "sort",
          "order",
          "per_page",
          "page",
        ]),
        headers: githubHeaders,
      };
    case "github:GITHUB_CREATE_AN_ISSUE": {
      const owner = requiredString(input, "owner");
      const repo = requiredString(input, "repo");
      requiredString(input, "title");
      return {
        method: "POST",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        body: pick(input, [
          "title",
          "body",
          "assignee",
          "milestone",
          "labels",
          "assignees",
        ]),
        headers: githubHeaders,
      };
    }

    case "supabase:SUPABASE_LIST_ALL_PROJECTS":
      return { method: "GET", path: "/v1/projects" };
    case "supabase:SUPABASE_GET_PROJECT":
      return {
        method: "GET",
        path: `/v1/projects/${encodeURIComponent(requiredString(input, "ref", "project_ref"))}`,
      };
    case "supabase:SUPABASE_LIST_ALL_ORGANIZATIONS":
      return { method: "GET", path: "/v1/organizations" };
    case "supabase:SUPABASE_CREATE_A_PROJECT":
      requiredString(input, "name");
      requiredString(input, "organization_id");
      requiredString(input, "region");
      requiredString(input, "db_pass");
      return {
        method: "POST",
        path: "/v1/projects",
        body: pick(input, [
          "name",
          "organization_id",
          "region",
          "db_pass",
          "plan",
          "kps_enabled",
          "template_url",
          "postgres_engine",
          "release_channel",
          "desired_instance_size",
        ]),
      };
    default:
      return null;
  }
};
