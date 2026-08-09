/**
 * The frozen `connect` object graph inside the Node REPL worker.
 *
 * Mirrors `browser-use/worker-api.ts`: this function's SOURCE is embedded
 * into the eval'd worker (via `toString()`), so keep every runtime
 * dependency inside the function body. It only shapes/validates arguments
 * and forwards them over the kernel protocol (`connect-call` messages);
 * all real work — catalog resolution, the CLI bridge, the backend
 * connector action broker — happens host-side in
 * `connectors/connect-service.ts`.
 */

export type ConnectWorkerMethod =
  | "discover"
  | "connectors"
  | "actions"
  | "schema"
  | "call"
  | "addMcp"
  | "remove";

export type ConnectWorkerCall = (
  method: ConnectWorkerMethod,
  args: readonly unknown[],
) => Promise<unknown>;

export interface ConnectWorkerApi {
  documentation(): string;
  discover(query: string): Promise<unknown>;
  connectors(): Promise<unknown>;
  actions(
    id: string,
    options?: Readonly<{ query?: string; limit?: number }>,
  ): Promise<unknown>;
  schema(id: string, action: string): Promise<unknown>;
  call(
    id: string,
    action: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  addMcp(options: Readonly<Record<string, unknown>>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

/**
 * Installs the `connect` client inside the Node REPL worker. Keep every
 * runtime dependency inside this function: its source is stringified into
 * the worker bootstrap.
 */
export function installConnectWorkerApi(
  callConnect: ConnectWorkerCall,
): ConnectWorkerApi {
  if (typeof callConnect !== "function") {
    throw new TypeError("callConnect must be a function.");
  }

  const DOCUMENTATION = `Connect client — third-party app integrations (Gmail, Google Docs, Notion, Slack, ...). All methods are async; results are plain JS values and failures throw Error with the broker's message.

connect.discover(query) — keyword-search the whole integration catalog (max 8 matches). Each match carries enabled/connected/declined state and a "next" hint; follow it instead of guessing.
connect.connectors() — integrations enabled right now: { id, name, kind, connected, description }.
connect.actions(id, { query, limit }) — capped action list (default 25, max 100) for one connector: name, one-line description, param summary. Pass query keywords to filter; "total" reports the full count.
connect.schema(id, action) — the full JSON input schema for one action. Check it before the first call of an unfamiliar action.
connect.call(id, action, args) — execute an action with a plain-object args. REST-style connectors also accept an API path: connect.call(id, "/v1/items", { method: "GET", query: {...}, body: {...} }).
connect.addMcp({ id, name?, transport, auth? }) — register an MCP server as a connector. transport is { url } (streamable HTTP) or { command, args?, env?, cwd? } (stdio); auth (optional) is { type: "oauth" | "api_key", tokenKey?, headerName?, scheme? }. Probes the server, persists it, and generates a skill; returns { imported, toolCount, skillPath }. If the probe needs auth it still imports with probeDeferred: true — credentials are collected on first use and the skill's action list fills in once connect.actions(id) succeeds.
  await connect.addMcp({ id: "linear", name: "Linear", transport: { url: "https://mcp.linear.app/mcp" }, auth: { type: "oauth" } });
  await connect.addMcp({ id: "my-tools", transport: { command: "npx", args: ["-y", "my-mcp-server"] } });
connect.remove(id) — uninstall an imported MCP/API connector: deletes its saved config, generated skill, and stored credentials. Native Store integrations are disabled in the Store instead.

Workflow: discover → actions → schema → call. If a connector is not connected, follow discover's "next" guidance (inline connect card via connector_status / Store) rather than retrying call. This client is the full connector surface — it manages connectors too (addMcp/remove), not just calls; there is no shell CLI for connectors.

Example:
const { matches } = await connect.discover("google docs");
const list = await connect.actions("googledocs", { query: "comment" });
const schema = await connect.schema("googledocs", list.actions[0].name);
const result = await connect.call("googledocs", list.actions[0].name, { document_id: "..." });`;

  const requireNonEmptyString = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`connect: ${name} must be a non-empty string.`);
    }
    return value.trim();
  };
  // Cross-realm safe: REPL cells build objects in the vm context, whose
  // Object.prototype is a different identity than this function's realm.
  const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null || prototype === Object.prototype) return true;
    return (
      Object.getPrototypeOf(prototype) === null &&
      typeof prototype.constructor === "function" &&
      prototype.constructor.name === "Object"
    );
  };
  const requirePlainObject = (
    value: unknown,
    name: string,
  ): Record<string, unknown> => {
    if (!isPlainObject(value)) {
      throw new TypeError(`connect: ${name} must be a plain object.`);
    }
    return value;
  };

  const connect: ConnectWorkerApi = Object.freeze({
    documentation: () => DOCUMENTATION,
    discover: (query: string) =>
      callConnect("discover", [requireNonEmptyString(query, "query")]),
    connectors: () => callConnect("connectors", []),
    actions: (
      id: string,
      options?: Readonly<{ query?: string; limit?: number }>,
    ) =>
      callConnect("actions", [
        requireNonEmptyString(id, "id"),
        options === undefined ? {} : requirePlainObject(options, "options"),
      ]),
    schema: (id: string, action: string) =>
      callConnect("schema", [
        requireNonEmptyString(id, "id"),
        requireNonEmptyString(action, "action"),
      ]),
    call: (
      id: string,
      action: string,
      args?: Readonly<Record<string, unknown>>,
    ) =>
      callConnect("call", [
        requireNonEmptyString(id, "id"),
        requireNonEmptyString(action, "action"),
        args === undefined ? {} : requirePlainObject(args, "args"),
      ]),
    addMcp: (options: Readonly<Record<string, unknown>>) =>
      callConnect("addMcp", [requirePlainObject(options, "options")]),
    remove: (id: string) =>
      callConnect("remove", [requireNonEmptyString(id, "id")]),
  });
  return connect;
}
