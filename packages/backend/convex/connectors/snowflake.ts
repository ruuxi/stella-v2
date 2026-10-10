import { ConnectorError, classifyProviderStatus } from "./errors";

/**
 * Snowflake is not a fixed-origin API. Every OAuth and SQL API request is bound
 * to the exact account origin supplied at connect time and verified here.
 */
export const SNOWFLAKE_HOST_SUFFIX = ".snowflakecomputing.com";
export const SNOWFLAKE_STATEMENTS_PATH = "/api/v2/statements/";

const MAX_SQL_LENGTH = 256 * 1024;
const MAX_CONTEXT_LENGTH = 255;
const MAX_STATUS_POLLS = 12;
const MAX_RESULT_PARTITIONS = 16;
const STATUS_POLL_DELAY_MS = 250;
const SAFE_STATEMENT_HANDLE = /^[A-Za-z0-9_-]{8,256}$/u;

export const normalizeSnowflakeAccountOrigin = (candidate: unknown): string => {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new ConnectorError("invalid_input");
  }
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    throw new ConnectorError("invalid_input");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    hostname.length > 253 ||
    !hostname.endsWith(SNOWFLAKE_HOST_SUFFIX) ||
    hostname === SNOWFLAKE_HOST_SUFFIX.slice(1)
  ) {
    throw new ConnectorError("invalid_input");
  }
  // URL rejects malformed DNS labels; these checks also reject IP-shaped and
  // wildcard account names without maintaining a brittle region allowlist.
  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new ConnectorError("invalid_input");
  }
  return `https://${hostname}`;
};

export const snowflakeAccountEndpoints = (candidate: unknown) => {
  const origin = normalizeSnowflakeAccountOrigin(candidate);
  return {
    origin,
    authorizationEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/oauth/token-request`,
    refreshEndpoint: `${origin}/oauth/token-request`,
  };
};

type SnowflakeStatementBody = {
  statement: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
  timeout?: number;
  bindings?: Record<string, { type: "TEXT"; value: string }>;
};

export type SnowflakeRequestPlan = {
  method: "POST";
  path: typeof SNOWFLAKE_STATEMENTS_PATH;
  body: SnowflakeStatementBody;
  operation: "read" | "write";
};

const SNOWFLAKE_CONTEXT_KEYS = [
  "warehouse",
  "database",
  "schema",
  "role",
] as const;

const readRequiredString = (
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ConnectorError("invalid_input");
  }
  return value;
};

const statementBody = (
  statement: string,
  input: Record<string, unknown>,
  bindings?: SnowflakeStatementBody["bindings"],
): SnowflakeStatementBody => {
  const body: SnowflakeStatementBody = { statement };
  for (const key of SNOWFLAKE_CONTEXT_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > MAX_CONTEXT_LENGTH
    ) {
      throw new ConnectorError("invalid_input");
    }
    body[key] = value;
  }
  if (input.timeout !== undefined) {
    if (
      typeof input.timeout !== "number" ||
      !Number.isSafeInteger(input.timeout) ||
      input.timeout < 1 ||
      input.timeout > 604_800
    ) {
      throw new ConnectorError("invalid_input");
    }
    body.timeout = input.timeout;
  }
  if (bindings) body.bindings = bindings;
  return body;
};

const allowedInputKeys = new Set([
  ...SNOWFLAKE_CONTEXT_KEYS,
  "timeout",
  "statement",
  "table",
]);

const rejectUnknownInput = (input: Record<string, unknown>): void => {
  if (Object.keys(input).some((key) => !allowedInputKeys.has(key))) {
    throw new ConnectorError("invalid_input");
  }
};

export const buildSnowflakeRequestPlan = (
  action: string,
  input: Record<string, unknown>,
): SnowflakeRequestPlan => {
  rejectUnknownInput(input);
  switch (action) {
    case "SNOWFLAKE_LIST_DATABASES":
      if (input.statement !== undefined || input.table !== undefined) {
        throw new ConnectorError("invalid_input");
      }
      return {
        method: "POST",
        path: SNOWFLAKE_STATEMENTS_PATH,
        body: statementBody("SHOW DATABASES", input),
        operation: "read",
      };
    case "SNOWFLAKE_DESCRIBE_TABLE": {
      if (input.statement !== undefined)
        throw new ConnectorError("invalid_input");
      const table = readRequiredString(input, "table", MAX_CONTEXT_LENGTH * 3);
      return {
        method: "POST",
        path: SNOWFLAKE_STATEMENTS_PATH,
        body: statementBody("DESCRIBE TABLE IDENTIFIER(?)", input, {
          "1": { type: "TEXT", value: table },
        }),
        operation: "read",
      };
    }
    case "SNOWFLAKE_EXECUTE_SQL_QUERY":
      if (input.table !== undefined) throw new ConnectorError("invalid_input");
      return {
        method: "POST",
        path: SNOWFLAKE_STATEMENTS_PATH,
        body: statementBody(
          readRequiredString(input, "statement", MAX_SQL_LENGTH),
          input,
        ),
        operation: "write",
      };
    default:
      throw new ConnectorError("action_not_found");
  }
};

const contextSchemaProperties = {
  warehouse: { type: "string", minLength: 1, maxLength: MAX_CONTEXT_LENGTH },
  database: { type: "string", minLength: 1, maxLength: MAX_CONTEXT_LENGTH },
  schema: { type: "string", minLength: 1, maxLength: MAX_CONTEXT_LENGTH },
  role: { type: "string", minLength: 1, maxLength: MAX_CONTEXT_LENGTH },
  timeout: { type: "integer", minimum: 1, maximum: 604_800 },
} as const;

export const SNOWFLAKE_ACTION_SCHEMAS = {
  SNOWFLAKE_LIST_DATABASES: {
    type: "object",
    properties: contextSchemaProperties,
    additionalProperties: false,
  },
  SNOWFLAKE_DESCRIBE_TABLE: {
    type: "object",
    properties: {
      ...contextSchemaProperties,
      table: {
        type: "string",
        minLength: 1,
        maxLength: MAX_CONTEXT_LENGTH * 3,
      },
    },
    required: ["table"],
    additionalProperties: false,
  },
  SNOWFLAKE_EXECUTE_SQL_QUERY: {
    type: "object",
    properties: {
      ...contextSchemaProperties,
      statement: { type: "string", minLength: 1, maxLength: MAX_SQL_LENGTH },
    },
    required: ["statement"],
    additionalProperties: false,
  },
} as const;

export const SNOWFLAKE_ACTION_OPERATIONS = {
  SNOWFLAKE_LIST_DATABASES: "read",
  SNOWFLAKE_DESCRIBE_TABLE: "read",
  SNOWFLAKE_EXECUTE_SQL_QUERY: "write",
} as const;

export const SNOWFLAKE_ACTION_REQUIRED_SCOPES = {
  SNOWFLAKE_LIST_DATABASES: ["session:role-any"],
  SNOWFLAKE_DESCRIBE_TABLE: ["session:role-any"],
  SNOWFLAKE_EXECUTE_SQL_QUERY: ["session:role-any"],
} as const;

export const SNOWFLAKE_CONNECTOR_ACTIONS = {
  snowflake: Object.keys(SNOWFLAKE_ACTION_OPERATIONS),
} as const;

type SnowflakePayload = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readBoundedJson = async (
  response: Response,
  remainingBytes: { value: number },
): Promise<SnowflakePayload> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > Math.max(remainingBytes.value, 0)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("response_too_large");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > remainingBytes.value) {
        await reader
          .cancel("response byte limit exceeded")
          .catch(() => undefined);
        throw new ConnectorError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  remainingBytes.value -= total;
  if (total === 0) return {};
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!isObject(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new ConnectorError("normalization_error");
  }
};

const waitForPoll = async (
  delayMs: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw new ConnectorError("provider_timeout", true);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ConnectorError("provider_timeout", true));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const statementHandleFromPayload = (payload: SnowflakePayload): string => {
  const handle = payload.statementHandle;
  if (typeof handle !== "string" || !SAFE_STATEMENT_HANDLE.test(handle)) {
    throw new ConnectorError("normalization_error");
  }
  return handle;
};

export const validateSnowflakeStatusUrl = (
  originCandidate: unknown,
  statementHandle: string,
  candidate: unknown,
): string => {
  const origin = normalizeSnowflakeAccountOrigin(originCandidate);
  if (!SAFE_STATEMENT_HANDLE.test(statementHandle)) {
    throw new ConnectorError("normalization_error");
  }
  if (typeof candidate === "string" && candidate.trim()) {
    let returned: URL;
    try {
      returned = new URL(candidate, `${origin}/`);
    } catch {
      throw new ConnectorError("normalization_error");
    }
    const expectedPath = `/api/v2/statements/${statementHandle}`;
    if (
      returned.origin !== origin ||
      returned.username ||
      returned.password ||
      returned.hash ||
      returned.pathname.replace(/\/$/u, "") !== expectedPath ||
      [...returned.searchParams.keys()].some(
        (key) => key !== "requestId" && key !== "partition",
      )
    ) {
      throw new ConnectorError("normalization_error");
    }
  }
  return `${origin}/api/v2/statements/${encodeURIComponent(statementHandle)}`;
};

const fetchSnowflakeJson = async (args: {
  fetchImpl: typeof fetch;
  url: string;
  method: "GET" | "POST";
  accessToken: string;
  body?: SnowflakeStatementBody;
  signal: AbortSignal;
  remainingBytes: { value: number };
}): Promise<{ response: Response; payload: SnowflakePayload }> => {
  let response: Response;
  try {
    response = await args.fetchImpl(args.url, {
      method: args.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${args.accessToken}`,
        "x-snowflake-authorization-token-type": "OAUTH",
        ...(args.body ? { "content-type": "application/json" } : {}),
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
      redirect: "error",
      signal: args.signal,
    });
  } catch (error) {
    if (
      args.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw new ConnectorError("provider_timeout", true);
    }
    throw new ConnectorError("provider_unavailable", true);
  }
  if (response.redirected) {
    await response.body
      ?.cancel("redirects are not allowed")
      .catch(() => undefined);
    throw new ConnectorError("provider_unavailable", true);
  }
  const payload = await readBoundedJson(response, args.remainingBytes);
  return { response, payload };
};

const rejectProviderResponse = (response: Response): never => {
  const classified = classifyProviderStatus(response.status);
  throw new ConnectorError(classified.code, classified.retryable);
};

/**
 * Execute one SQL API statement. The POST is issued exactly once, including for
 * write-classified SQL. Subsequent requests only poll/fetch that statement
 * handle; redirects and cross-account status URLs are refused.
 */
export const executeSnowflakeStatement = async (args: {
  accountOrigin: unknown;
  accessToken: string;
  body: SnowflakeStatementBody;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<SnowflakePayload> => {
  const origin = normalizeSnowflakeAccountOrigin(args.accountOrigin);
  if (
    !Number.isSafeInteger(args.maxResponseBytes) ||
    args.maxResponseBytes < 1 ||
    !Number.isSafeInteger(args.requestTimeoutMs) ||
    args.requestTimeoutMs < 1
  ) {
    throw new ConnectorError("normalization_error");
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("snowflake request timed out"),
    args.requestTimeoutMs,
  );
  const remainingBytes = { value: args.maxResponseBytes };
  try {
    const requestId = crypto.randomUUID();
    const submitUrl = new URL(SNOWFLAKE_STATEMENTS_PATH, `${origin}/`);
    submitUrl.searchParams.set("requestId", requestId);
    let { response, payload } = await fetchSnowflakeJson({
      fetchImpl,
      url: submitUrl.toString(),
      method: "POST",
      accessToken: args.accessToken,
      body: args.body,
      signal: controller.signal,
      remainingBytes,
    });

    let statementHandle: string | null = null;
    const statementWasSubmitted = response.status === 202;
    for (
      let poll = 0;
      statementWasSubmitted &&
      (response.status === 202 || response.status === 429);
      poll += 1
    ) {
      if (poll >= MAX_STATUS_POLLS) {
        throw new ConnectorError("provider_timeout", true);
      }
      if (!statementHandle)
        statementHandle = statementHandleFromPayload(payload);
      const statusBase = validateSnowflakeStatusUrl(
        origin,
        statementHandle,
        payload.statementStatusUrl,
      );
      await waitForPoll(
        STATUS_POLL_DELAY_MS * Math.min(poll + 1, 4),
        controller.signal,
      );
      const statusUrl = new URL(statusBase);
      statusUrl.searchParams.set("requestId", crypto.randomUUID());
      ({ response, payload } = await fetchSnowflakeJson({
        fetchImpl,
        url: statusUrl.toString(),
        method: "GET",
        accessToken: args.accessToken,
        signal: controller.signal,
        remainingBytes,
      }));
    }
    if (!response.ok) rejectProviderResponse(response);

    const metadata = isObject(payload.resultSetMetaData)
      ? payload.resultSetMetaData
      : null;
    const partitionInfo = Array.isArray(metadata?.partitionInfo)
      ? metadata.partitionInfo
      : [];
    if (partitionInfo.length > MAX_RESULT_PARTITIONS) {
      throw new ConnectorError("response_too_large");
    }
    if (partitionInfo.length > 1) {
      statementHandle ??= statementHandleFromPayload(payload);
      const allData = Array.isArray(payload.data) ? [...payload.data] : [];
      for (
        let partition = 1;
        partition < partitionInfo.length;
        partition += 1
      ) {
        const partitionUrl = new URL(
          validateSnowflakeStatusUrl(
            origin,
            statementHandle,
            payload.statementStatusUrl,
          ),
        );
        partitionUrl.searchParams.set("partition", String(partition));
        partitionUrl.searchParams.set("requestId", crypto.randomUUID());
        const part = await fetchSnowflakeJson({
          fetchImpl,
          url: partitionUrl.toString(),
          method: "GET",
          accessToken: args.accessToken,
          signal: controller.signal,
          remainingBytes,
        });
        if (!part.response.ok) rejectProviderResponse(part.response);
        if (!Array.isArray(part.payload.data)) {
          throw new ConnectorError("normalization_error");
        }
        allData.push(...part.payload.data);
      }
      payload = { ...payload, data: allData };
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
};

export type SnowflakeProviderIdentity = {
  id: string;
  accountLocator: string;
  userName: string;
  displayName: string;
};

export const fetchSnowflakeProviderIdentity = async (args: {
  accountOrigin: unknown;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<SnowflakeProviderIdentity> => {
  const origin = normalizeSnowflakeAccountOrigin(args.accountOrigin);
  const payload = await executeSnowflakeStatement({
    accountOrigin: origin,
    accessToken: args.accessToken,
    body: {
      statement:
        "SELECT CURRENT_ACCOUNT() AS ACCOUNT_LOCATOR, CURRENT_USER() AS USER_NAME",
    },
    maxResponseBytes: 256 * 1024,
    requestTimeoutMs: 30_000,
    fetchImpl: args.fetchImpl,
  });
  const row = Array.isArray(payload.data) ? payload.data[0] : null;
  if (
    !Array.isArray(row) ||
    typeof row[0] !== "string" ||
    !row[0].trim() ||
    typeof row[1] !== "string" ||
    !row[1].trim()
  ) {
    throw new ConnectorError("identity_unavailable");
  }
  const accountLocator = row[0].trim();
  const userName = row[1].trim();
  if (accountLocator.length > 255 || userName.length > 255) {
    throw new ConnectorError("identity_unavailable");
  }
  const host = new URL(origin).hostname;
  return {
    id: `${host}:${accountLocator}:${userName}`,
    accountLocator,
    userName,
    displayName: `${userName} @ ${host}`,
  };
};
