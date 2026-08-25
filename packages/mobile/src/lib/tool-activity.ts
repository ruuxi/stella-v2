export type ToolActivityCategory =
  | "read"
  | "edit"
  | "search"
  | "web"
  | "command"
  | "create"
  | "memory"
  | "schedule"
  | "message"
  | "other";

export type ToolActivityStatus = "running" | "completed" | "error" | "canceled";

export type ToolStep = {
  id: string;
  toolName: string;
  status: ToolActivityStatus;

  args?: Record<string, string>;

  resultPreview?: string;

  textOffset?: number;
};

export type ToolActivityStep = {
  id: string;
  toolName: string;
  category: ToolActivityCategory;

  title: string;
  status: ToolActivityStatus;
  textOffset?: number;
};

export type ToolActivityGroup = {
  steps: ToolActivityStep[];

  summary: string;

  icon: ToolActivityCategory;
};

const EXCLUDED_TOOLS = new Set([
  "spawn_agent",
  "send_input",
  "pause_agent",
  "resume_agent",
  "search_threads",
  "run_workflow",
  "task",
  "multi_tool_use_parallel",
]);

type PhraseFn = (count: number) => string;

const plural =
  (one: string, many: (n: number) => string): PhraseFn =>
  (n) =>
    n === 1 ? one : many(n);

type ToolDescriptor = { category: ToolActivityCategory; phrase: PhraseFn };

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  read: { category: "read", phrase: plural("read a file", (n) => `read ${n} files`) },
  view_image: {
    category: "read",
    phrase: plural("viewed an image", (n) => `viewed ${n} images`),
  },
  edit: { category: "edit", phrase: plural("edited a file", (n) => `edited ${n} files`) },
  write: { category: "edit", phrase: plural("wrote a file", (n) => `wrote ${n} files`) },
  strreplace: {
    category: "edit",
    phrase: plural("edited a file", (n) => `edited ${n} files`),
  },
  apply_patch: {
    category: "edit",
    phrase: plural("applied a patch", (n) => `applied ${n} patches`),
  },
  scriptdraft: {
    category: "edit",
    phrase: plural("drafted a script", (n) => `drafted ${n} scripts`),
  },
  grep: { category: "search", phrase: () => "searched code" },
  tool_search: {
    category: "search",
    phrase: plural("looked up a tool", (n) => `looked up ${n} tools`),
  },
  web: { category: "web", phrase: () => "searched the web" },
  map: {
    category: "web",
    phrase: plural("looked up a map", (n) => `looked up ${n} maps`),
  },
  import_source: {
    category: "web",
    phrase: plural("imported a source", (n) => `imported ${n} sources`),
  },
  exec_command: {
    category: "command",
    phrase: plural("ran a command", (n) => `ran ${n} commands`),
  },
  write_stdin: {
    category: "command",
    phrase: plural("sent input to a command", (n) => `sent input ${n} times`),
  },
  image_gen: {
    category: "create",
    phrase: plural("generated an image", (n) => `generated ${n} images`),
  },
  pdf: {
    category: "create",
    phrase: plural("created a PDF", (n) => `created ${n} PDFs`),
  },
  html: { category: "create", phrase: plural("built a page", (n) => `built ${n} pages`) },
  recall: { category: "memory", phrase: () => "checked memory" },
  remember: {
    category: "memory",
    phrase: plural("saved a note", (n) => `saved ${n} notes`),
  },
  forget: {
    category: "memory",
    phrase: plural("removed a note", (n) => `removed ${n} notes`),
  },
  schedule: { category: "schedule", phrase: () => "updated scheduling" },
  schedule_add: { category: "schedule", phrase: () => "added a schedule" },
  schedule_list: { category: "schedule", phrase: () => "checked schedules" },
  schedule_update: { category: "schedule", phrase: () => "updated schedules" },
  schedule_remove: { category: "schedule", phrase: () => "removed a schedule" },
  cronadd: { category: "schedule", phrase: () => "updated schedules" },
  cronupdate: { category: "schedule", phrase: () => "updated schedules" },
  cronremove: { category: "schedule", phrase: () => "updated schedules" },
  cronrun: { category: "schedule", phrase: () => "ran a schedule" },
  cronlist: { category: "schedule", phrase: () => "checked schedules" },
  heartbeatget: { category: "schedule", phrase: () => "checked heartbeats" },
  heartbeatrun: { category: "schedule", phrase: () => "ran a heartbeat" },
  heartbeatupsert: { category: "schedule", phrase: () => "updated heartbeats" },
  request_credential: { category: "other", phrase: () => "requested access" },
  requestcredential: { category: "other", phrase: () => "requested access" },
};

const humanizeToolName = (toolName: string): string =>
  toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();

const descriptorFor = (toolName: string): ToolDescriptor => {
  const known = TOOL_DESCRIPTORS[toolName.toLowerCase()];
  if (known) return known;
  const human = humanizeToolName(toolName);
  return {
    category: "other",
    phrase: plural(`used ${human}`, (n) => `used ${human} ×${n}`),
  };
};

const failedSummary = (step: ToolActivityStep): string => {
  const outcome = step.status === "canceled" ? "canceled" : "failed";
  switch (step.toolName.toLowerCase()) {
    case "web":
      return `Web search ${outcome}`;
    case "pdf":
      return `PDF creation ${outcome}`;
    case "map":
      return `Map lookup ${outcome}`;
    case "recall":
      return `Memory lookup ${outcome}`;
    case "remember":
      return `Saving note ${outcome}`;
    case "forget":
      return `Removing note ${outcome}`;
    default:
      return `${capitalize(humanizeToolName(step.toolName))} ${outcome}`;
  }
};

const DEV_CATEGORIES = new Set<ToolActivityCategory>([
  "read",
  "edit",
  "search",
  "web",
  "command",
]);

const aggregateKey = (step: ToolActivityStep): string =>
  DEV_CATEGORIES.has(step.category)
    ? `cat:${step.category}`
    : `tool:${step.toolName.toLowerCase()}`;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

const clamp = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const titleForCall = (
  toolName: string,
  args: Record<string, string> | undefined,
): string => {
  const a = args ?? {};
  switch (toolName.toLowerCase()) {
    case "read":
    case "view_image": {
      const path = str(a.path) ?? str(a.file_path);
      return path ? basename(path) : "file";
    }
    case "edit":
    case "write":
    case "strreplace": {
      const path = str(a.file_path) ?? str(a.path);
      return path ? basename(path) : "file";
    }
    case "apply_patch":
      return "patch";
    case "grep":
      return str(a.pattern) ? `"${clamp(str(a.pattern)!, 32)}"` : "code";
    case "web": {
      const query = str(a.query);
      if (query) return `"${clamp(query, 40)}"`;
      const url = str(a.url);
      if (url) {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      }
      return "the web";
    }
    case "exec_command": {
      const cmd = str(a.cmd) ?? str(a.command);
      return cmd ? clamp(cmd, 48) : "command";
    }
    case "image_gen":
      return str(a.prompt) ? clamp(str(a.prompt)!, 48) : "image";
    case "pdf":
      return str(a.title) ?? "PDF";
    case "html":
      return str(a.title) ?? "page";
    case "remember":
      return str(a.title) ?? str(a.name) ?? "note";
    case "recall":
      return str(a.query) ? `"${clamp(str(a.query)!, 40)}"` : "memory";
    default:
      return humanizeToolName(toolName);
  }
};

const capitalize = (text: string): string =>
  text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);

const joinPhrases = (phrases: string[]): string => {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return capitalize(phrases[0]);
  const head = phrases.slice(0, -1).join(", ");
  return capitalize(`${head} and ${phrases[phrases.length - 1]}`);
};

export function deriveToolActivity(
  rawSteps: readonly ToolStep[],
): ToolActivityGroup | undefined {
  const settled: ToolActivityStep[] = [];
  for (const raw of rawSteps) {
    if (EXCLUDED_TOOLS.has(raw.toolName.toLowerCase())) continue;
    settled.push({
      id: raw.id,
      toolName: raw.toolName,
      category: descriptorFor(raw.toolName).category,
      title: titleForCall(raw.toolName, raw.args),
      status: raw.status,
      ...(typeof raw.textOffset === "number"
        ? { textOffset: raw.textOffset }
        : {}),
    });
  }
  if (settled.length === 0) return undefined;

  const order: string[] = [];
  const groupCount = new Map<string, number>();
  const groupSample = new Map<string, ToolActivityStep>();
  for (const step of settled) {
    const key = aggregateKey(step);
    if (!groupCount.has(key)) {
      order.push(key);
      groupSample.set(key, step);
    }
    groupCount.set(key, (groupCount.get(key) ?? 0) + 1);
  }

  const summary = joinPhrases(
    order.map((key) => {
      const sample = groupSample.get(key)!;
      return descriptorFor(sample.toolName).phrase(groupCount.get(key) ?? 0);
    }),
  );

  const active = settled.find((step) => step.status === "running");
  const failed = settled.find(
    (step) => step.status === "error" || step.status === "canceled",
  );
  const displayedSummary = active
    ? active.toolName.toLowerCase() === "web"
      ? "Searching the web"
      : active.toolName.toLowerCase() === "image_gen"
        ? "Creating image"
        : active.toolName.toLowerCase() === "pdf"
          ? "Creating PDF"
          : active.toolName.toLowerCase() === "map"
            ? "Looking up map"
            : active.toolName.toLowerCase() === "recall"
              ? "Checking memory"
              : `Using ${humanizeToolName(active.toolName)}`
    : failed
      ? failedSummary(failed)
      : summary;

  let iconKey = order[0];
  let best = -1;
  for (const key of order) {
    const count = groupCount.get(key) ?? 0;
    if (count > best) {
      best = count;
      iconKey = key;
    }
  }
  const icon = groupSample.get(iconKey)!.category;

  return { steps: settled, summary: displayedSummary, icon };
}
