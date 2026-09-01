const command = (group, name, handler, summary, aliases = []) => ({
  id: `${group}.${name}`,
  group,
  name,
  handler,
  summary,
  aliases,
});

export const COMMANDS = [
  command("session", "launch", "launch", "Launch an isolated Stella instance", ["launch"]),
  command("session", "doctor", "doctor", "Check the owned instance end to end", ["doctor"]),
  command("session", "info", "info", "Read the owned session record", ["info"]),
  command("chat", "ready", "chat-ready", "Return semantic chat readiness"),
  command("chat", "new", "chat-new", "Create and select a new conversation", ["new-session"]),
  command("chat", "send", "chat-send", "Send text through the real composer", ["send"]),
  command("chat", "state", "chat-state", "Inspect conversation and composer state"),
  command("nav", "home", "nav-home", "Open the current Home overlay", ["home"]),
  command("nav", "history", "nav-history", "Open Conversation history", ["history"]),
  command("nav", "quick-chat", "nav-quick-chat", "Open Quick chat from New tab"),
  command("nav", "files", "nav-files", "Open Files from New tab"),
  command("nav", "browser", "nav-browser", "Open Browser from New tab"),
  command("settings", "open", "settings-open", "Open Settings through the visible menu"),
  command("settings", "tab", "settings-tab", "Select a Settings tab"),
  command("settings", "search", "settings-search", "Search the complete Settings catalog"),
  command("settings", "state", "settings-state", "Read Settings dialog state"),
  command("settings", "close", "settings-close", "Close Settings safely"),
  command("apps", "open", "apps-open", "Open the Apps library from New tab", ["apps"]),
  command("apps", "state", "apps-state", "Classify the visible Apps state"),
  command("apps", "ask", "apps-ask", "Use the empty-state create-app handoff"),
  command("inspect", "state", "inspect-state", "Read a redacted semantic shell state"),
  command("inspect", "components", "components", "List visible interactive components", ["components"]),
  command("inspect", "aria", "snapshot", "Write an accessibility snapshot", ["snapshot"]),
  command("inspect", "screenshot", "screenshot", "Write a renderer screenshot", ["screenshot"]),
  command("inspect", "eval", "eval", "Evaluate explicit JavaScript as an unsafe escape hatch", ["eval"]),
  command("drive", "click", "click", "Click by accessible handle", ["click"]),
  command("drive", "click-xy", "click-xy", "Click an inspected viewport coordinate", ["click-xy"]),
  command("drive", "fill", "fill", "Replace a textbox value", ["fill", "type"]),
  command("drive", "press", "press", "Press a supported key", ["press"]),
  command("drive", "scroll", "scroll", "Scroll the window or a named element", ["scroll"]),
  command("drive", "wait", "wait", "Wait for a visible semantic target", ["wait"]),
  command("drive", "settle", "wait-settle", "Wait for a quiet DOM interval", ["wait-settle"]),
  command("performance", "metrics", "perf-metrics", "Read renderer performance metrics", ["perf-metrics"]),
  command("performance", "trace", "trace", "Capture a Chrome trace", ["trace"]),
  command("performance", "profile", "profile", "Capture a CPU profile", ["profile"]),
  command("diagnostics", "logs", "logs", "Read redacted owned process logs", ["logs"]),
  command("diagnostics", "console", "console", "Capture bounded renderer console events", ["console"]),
  command("diagnostics", "network-log", "network-log", "Capture bounded network events", ["network-log"]),
  command("diagnostics", "network-summary", "network-summary", "Summarize bounded network events", ["network-summary"]),
  command("cleanup", "plan", "cleanup-plan", "Preview exact owned cleanup targets"),
  command("cleanup", "apply", "stop", "Stop the owned instance and preserve evidence", ["cleanup", "stop"]),
];

const byId = new Map(COMMANDS.map((entry) => [entry.id, entry]));
const byAlias = new Map(
  COMMANDS.flatMap((entry) => entry.aliases.map((alias) => [alias, entry])),
);
const groups = new Set(COMMANDS.map((entry) => entry.group));

export const resolveCommand = (parts) => {
  if (parts.length === 0) return null;
  if (parts[0] === "help" || parts[0] === "capabilities") {
    return {
      entry: { id: parts[0], handler: parts[0], group: "meta", name: parts[0] },
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

export const capabilities = () =>
  Object.fromEntries(
    [...groups].sort().map((group) => [
      group,
      COMMANDS.filter((entry) => entry.group === group).map(
        ({ name, summary, aliases }) => ({ name, summary, aliases }),
      ),
    ]),
  );

export const helpText = () => {
  const lines = [
    "Usage: node .agents/skills/verify-stella/control-stella.mjs <group> <command> [options]",
    "",
    "Agent-friendly control utility for one helper-owned Stella Electron instance.",
    "Commands write JSON except help and ARIA artifact contents; failures include recovery guidance.",
    "",
  ];
  for (const [group, entries] of Object.entries(capabilities())) {
    lines.push(`${group}:`);
    for (const entry of entries) {
      lines.push(`  ${entry.name.padEnd(16)} ${entry.summary}`);
    }
    lines.push("");
  }
  lines.push("Common forms:");
  lines.push("  session launch [--replace]");
  lines.push("  chat send --text <message> [--timeout <ms>]");
  lines.push("  settings tab --name <tab>");
  lines.push("  settings search --query <text>");
  lines.push("  inspect aria|screenshot --path <artifact>");
  lines.push("  inspect eval --js <expression>              unsafe escape hatch");
  lines.push("  drive click --role <role> --name <name>");
  lines.push("  drive fill --placeholder <text> --value <text>");
  lines.push("  drive press --key <key-or-chord>             e.g. Shift+Enter, Meta+KeyN");
  lines.push("  diagnostics console|network-log [--duration <ms>] [--limit <count>]");
  lines.push("  performance trace|profile --duration <ms> --path <artifact>");
  lines.push("  cleanup apply --dry-run");
  lines.push("");
  lines.push("Safety:");
  lines.push("  Only the run recorded in .agents/skills/verify-stella/.run/current.json is driven.");
  lines.push("  Cleanup targets exact recorded PIDs and paths, preserves durable run data and artifacts,");
  lines.push("  and can be previewed with `cleanup plan` or `cleanup apply --dry-run`.");
  lines.push("");
  lines.push("Run `capabilities` for the same command surface as JSON.");
  lines.push("Legacy flat aliases remain available during migration.");
  return `${lines.join("\n")}\n`;
};
