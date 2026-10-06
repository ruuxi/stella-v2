const command = (group, name, handler, summary, { aliases = [], usage = "", flags = [], switches = [], positional = null } = {}) => ({
  id: `${group}.${name}`,
  group,
  name,
  handler,
  summary,
  aliases,
  usage,
  flags,
  switches,
  positional,
});

const QUERY_FLAGS = ["role", "name", "selector", "within"];

export const COMMANDS = [
  command("session", "launch", "launch", "Launch an isolated Stella instance", {
    aliases: ["launch"],
    usage: "[--replace] [--account anonymous|signed-in|go|pro] [--reuse] [--fake-mic <wav>] [--browser-bridge shared|isolated] [--runtime-binary <native-executable>] [--model-gateway <origin>]",
    flags: ["account", "fake-mic", "browser-bridge", "runtime-binary", "model-gateway"],
    switches: ["replace", "reuse"],
  }),
  command("session", "doctor", "doctor", "Check the owned instance end to end; exit 2 when unhealthy", { aliases: ["doctor"] }),
  command("session", "info", "info", "Read the owned session record", { aliases: ["info"] }),
  command("chat", "ready", "chat-ready", "Return semantic chat readiness; exit 2 when not ready"),
  command("chat", "send", "chat-send", "Send text through the real composer and watch for the user message or a notice", {
    aliases: ["send"],
    usage: "--text <message> [--timeout <ms, 500-120000, default 10000>]",
    flags: ["text", "timeout"],
    positional: "message",
  }),
  command("chat", "state", "chat-state", "Inspect conversation and composer state"),
  command("nav", "home", "nav-home", "Check the current automatic Home overlay", { aliases: ["home"] }),
  command("nav", "files", "nav-files", "Open Files from New tab"),
  command("nav", "browser", "nav-browser", "Open Browser from New tab"),
  command("settings", "open", "settings-open", "Open Settings through the visible menu"),
  command("settings", "tab", "settings-tab", "Select a Settings tab", { usage: "--name <tab>", flags: ["name"], positional: "tab" }),
  command("settings", "search", "settings-search", "Search the complete Settings catalog and return the result text", { usage: "--query <text>", flags: ["query"], positional: "text" }),
  command("settings", "state", "settings-state", "Read shell state (settingsOpen, selectedTabs); not the dialog's contents"),
  command("settings", "close", "settings-close", "Close Settings safely"),
  command("apps", "open", "apps-open", "Open the Apps library from New tab", { aliases: ["apps"] }),
  command("apps", "state", "apps-state", "Observe the visible Apps surface without inferring readiness"),
  command("apps", "ask", "apps-ask", "Use the empty-state create-app handoff"),
  command("inspect", "observe", "observe", "Capture state, controls, ARIA and screenshot; optionally compare a previous observation", {
    usage: "--path <directory> [--since <observation.json>]",
    flags: ["path", "since"],
  }),
  command("inspect", "state", "inspect-state", "Read a redacted semantic shell state"),
  command("inspect", "components", "components", "List visible interactive components", { aliases: ["components"] }),
  command("inspect", "aria", "snapshot", "Write a DOM-derived accessibility outline", { aliases: ["snapshot"], usage: "--path <file>", flags: ["path"] }),
  command("inspect", "screenshot", "screenshot", "Write a renderer screenshot", { aliases: ["screenshot"], usage: "--path <file.png>", flags: ["path"] }),
  command("inspect", "eval", "eval", "Evaluate explicit JavaScript as an unsafe escape hatch", { aliases: ["eval"], usage: "--js <expression>", flags: ["js"] }),
  command("drive", "click", "click", "Click by accessible handle", {
    aliases: ["click"],
    usage: "[--role <role>] [--name <exact accessible name>] [--selector <CSS>] [--within <CSS scope>]",
    flags: QUERY_FLAGS,
  }),
  command("drive", "click-xy", "click-xy", "Click an inspected viewport coordinate", { aliases: ["click-xy"], usage: "--x <px> --y <px>", flags: ["x", "y"], positional: "x y" }),
  command("drive", "fill", "fill", "Replace a textbox value", {
    aliases: ["fill", "type"],
    usage: "--value <text> (--placeholder <text> | --name <name> | --selector <CSS>) [--role <role>] [--within <CSS scope>]",
    flags: [...QUERY_FLAGS, "placeholder", "value"],
  }),
  command("drive", "press", "press", "Press a supported key", { aliases: ["press"], usage: "--key <key-or-chord>   e.g. Enter, Escape, Shift+Enter, Control+KeyT, Meta+KeyN", flags: ["key"] }),
  command("drive", "scroll", "scroll", "Scroll the document or one element by a pixel offset", {
    aliases: ["scroll"],
    usage: "[--selector <CSS of the scroll container>] [--x <px>] [--y <px>]   e.g. --selector .settings-panel --y 800",
    flags: ["selector", "x", "y"],
  }),
  command("drive", "wait", "wait", "Wait for a visible semantic target (multiple matches allowed)", {
    aliases: ["wait"],
    usage: "(--role | --name | --selector | --placeholder | --text) <value> [--within <CSS scope>] [--timeout <ms, default 10000>]",
    flags: [...QUERY_FLAGS, "placeholder", "text", "timeout"],
  }),
  command("drive", "settle", "wait-settle", "Wait for a quiet DOM interval, ignoring decorative SVG animation", {
    aliases: ["wait-settle"],
    usage: "[--quiet <ms, 100-5000, default 500>] [--timeout <ms, quiet-13000, default 10000>] [--ignore <CSS>]",
    flags: ["quiet", "timeout", "ignore"],
  }),
  command("performance", "metrics", "perf-metrics", "Read renderer performance metrics", { aliases: ["perf-metrics"] }),
  command("performance", "trace", "trace", "Capture a Chrome trace", { aliases: ["trace"], usage: "--path <file.json> [--duration <ms, 250-10000, default 3000>]", flags: ["path", "duration"] }),
  command("performance", "profile", "profile", "Capture a CPU profile", { aliases: ["profile"], usage: "--path <file.json> [--duration <ms, 250-10000, default 3000>]", flags: ["path", "duration"] }),
  command("diagnostics", "logs", "logs", "Read redacted owned process logs", { aliases: ["logs"], usage: "[--tail <lines, 1-2000, default 200>]", flags: ["tail"] }),
  command("diagnostics", "console", "console", "Capture bounded renderer console events", { aliases: ["console"], usage: "[--duration <ms, 100-10000, default 2000>] [--limit <count, 1-1000, default 50>]", flags: ["duration", "limit"] }),
  command("diagnostics", "network-log", "network-log", "Capture bounded network events", { aliases: ["network-log"], usage: "[--duration <ms, 100-10000, default 2000>] [--limit <count, 1-1000, default 100>]", flags: ["duration", "limit"] }),
  command("diagnostics", "network-summary", "network-summary", "Summarize bounded network events", { aliases: ["network-summary"], usage: "[--duration <ms, 100-10000, default 2000>] [--limit <count, 1-2000, default 500>]", flags: ["duration", "limit"] }),
  command("cleanup", "plan", "cleanup-plan", "Preview exact owned cleanup targets"),
  command("cleanup", "apply", "stop", "Stop the owned instance and preserve evidence", { aliases: ["cleanup", "stop"], usage: "[--dry-run]", switches: ["dry-run"] }),
];

export const GLOBAL_SWITCHES = ["help"];

export const BOOLEAN_FLAGS = new Set([
  ...GLOBAL_SWITCHES,
  ...COMMANDS.flatMap((entry) => entry.switches),
]);

const byId = new Map(COMMANDS.map((entry) => [entry.id, entry]));
const byAlias = new Map(
  COMMANDS.flatMap((entry) => entry.aliases.map((alias) => [alias, entry])),
);
const groups = new Set(COMMANDS.map((entry) => entry.group));

export const resolveCommand = (parts) => {
  if (parts.length === 0) return null;
  if (parts[0] === "help" || parts[0] === "capabilities") {
    return {
      entry: { id: parts[0], handler: parts[0], group: "meta", name: parts[0], flags: [], switches: [] },
      positionals: parts.slice(1),
      grouped: false,
    };
  }
  if (groups.has(parts[0])) {
    const entry = byId.get(`${parts[0]}.${parts[1] ?? ""}`);
    if (!entry) return null;
    return { entry, positionals: parts.slice(2), grouped: true };
  }
  const entry = byAlias.get(parts[0]);
  return entry
    ? { entry, positionals: parts.slice(1), grouped: false }
    : null;
};

export const unknownOptions = (entry, options) =>
  Object.keys(options).filter(
    (key) =>
      key !== "_" &&
      !GLOBAL_SWITCHES.includes(key) &&
      !(entry.flags ?? []).includes(key) &&
      !(entry.switches ?? []).includes(key),
  );

export const unexpectedPositionals = (entry, positionals) =>
  entry.positional || entry.id === "help" || entry.id === "capabilities" ? [] : positionals;

export const commandHelp = (entry) => {
  const lines = [
    `Usage: node .agents/skills/verify-stella/control-stella.mjs ${entry.group} ${entry.name}${entry.usage ? ` ${entry.usage}` : ""}`,
    "",
    entry.summary,
  ];
  if (entry.positional) lines.push(`The ${entry.positional} may also be given positionally.`);
  if (entry.aliases.length) lines.push(`Aliases: ${entry.aliases.join(", ")}`);
  lines.push("Options not listed here are rejected. Output is one JSON envelope: {ok, command, data, meta} or {ok:false, command, error}.");
  return `${lines.join("\n")}\n`;
};

export const capabilities = () =>
  Object.fromEntries(
    [...groups].sort().map((group) => [
      group,
      COMMANDS.filter((entry) => entry.group === group).map(
        ({ name, summary, aliases, usage, flags, switches, positional }) => ({
          name,
          summary,
          usage,
          flags,
          switches,
          positional,
          aliases,
        }),
      ),
    ]),
  );

export const helpText = () => {
  const lines = [
    "Usage: node .agents/skills/verify-stella/control-stella.mjs <group> <command> [options]",
    "",
    "Agent-friendly control utility for one helper-owned Stella Electron instance.",
    "Every command except help writes one JSON envelope: {ok:true, command, data, meta} on stdout,",
    "or {ok:false, command, error:{code, message, recovery, retryable}} on stderr.",
    "Unknown options are rejected. `<group> <command> --help` prints that command's options.",
    "",
  ];
  for (const group of [...groups].sort()) {
    lines.push(`${group}:`);
    for (const entry of COMMANDS.filter((item) => item.group === group)) {
      lines.push(`  ${entry.name.padEnd(16)} ${entry.summary}`);
      if (entry.usage) lines.push(`  ${"".padEnd(16)}   ${entry.usage}`);
    }
    lines.push("");
  }
  lines.push("Safety:");
  lines.push("  Only the run recorded in .agents/skills/verify-stella/.run/current.json is driven.");
  lines.push("  Cleanup targets exact recorded PIDs and paths, preserves durable run data and artifacts,");
  lines.push("  and can be previewed with `cleanup plan` or `cleanup apply --dry-run`.");
  lines.push("");
  lines.push("Run `capabilities` for the same command surface, with options, as JSON.");
  lines.push("Legacy flat aliases remain available during migration.");
  return `${lines.join("\n")}\n`;
};
