/**
 * `connect.documentation()` text — the one description of the connector
 * client every code runtime hands the model. `installConnectWorkerApi`
 * (device kernel worker) carries a byte-identical inline copy because its
 * source is stringified into the eval'd worker and cannot import; a unit
 * test pins the two together.
 */
export const CONNECT_DOCUMENTATION = `Connect client — third-party app integrations (Gmail, Google Docs, Notion, Slack, ...). All methods are async; results are plain JS values and failures throw Error with the broker's message.

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
