const AGENT_WORK_VARIATIONS: readonly string[] = [
  "On it",
  "Working on it",
  "Got it",
  "Handling it",
  "Taking care of it",
  "Sorting it",
  "Doing the thing",
  "Making it happen",
  "Just a sec",
  "One moment",
];

const COMPUTER_WORK_VARIATIONS: readonly string[] = [
  "Checking",
  "Testing",
  "Verifying",
  "Checking it out",
  "Trying it",
  "Double-checking",
  "Making sure",
];

const TOOL_STATUS_BY_NAME: Record<string, readonly string[]> = {
  image_gen: [
    "Sketching",
    "Drawing",
    "Sketching it out",
    "Drawing it up",
    "Mocking it up",
    "Painting a picture",
    "Whipping up a visual",
    "Making an image",
  ],
  web: [
    "Searching",
    "Looking it up",
    "Googling",
    "Checking online",
    "Searching the web",
    "Looking that up",
    "Browsing",
    "Asking the internet",
  ],
  schedule: [
    "Scheduling",
    "Calendaring",
    "Penciling it in",
    "Booking it",
    "Saving the date",
    "Locking in the time",
    "Marking it down",
    "Setting a reminder",
    "Putting it on the schedule",
  ],

  recall: [
    "Searching my memory",
    "Digging through history",
    "Jogging my memory",
    "Thinking back",
    "Retracing our steps",
    "Flipping through old notes",
    "Rummaging through the archives",
    "Checking what we did before",
  ],
  remember: [
    "Making a note",
    "Writing it down",
    "Committing it to memory",
    "Jotting that down",
    "Saving that for later",
    "Adding it to my notes",
  ],
  spawn_agent: AGENT_WORK_VARIATIONS,
  send_input: AGENT_WORK_VARIATIONS,
  pause_agent: [
    "Pausing",
    "Holding up",
    "Hitting pause",
    "Putting a pin in it",
    "Holding off",
    "Taking a beat",
    "Easing off",
    "Slowing down",
    "Putting it on hold",
    "Standing by",
  ],

  exec_command: COMPUTER_WORK_VARIATIONS,
  node_repl: COMPUTER_WORK_VARIATIONS,
  bash: COMPUTER_WORK_VARIATIONS,
  read: [
    "Reading",
    "Looking it over",
    "Taking a look",
    "Reading through",
    "Checking the file",
    "Skimming it",
    "Pulling it up",
    "Having a read",
  ],
  write: [
    "Writing",
    "Saving it",
    "Writing it out",
    "Putting it down",
    "Drafting the file",
    "Getting it written",
    "Setting it up",
  ],
  edit: [
    "Editing",
    "Making changes",
    "Tweaking it",
    "Updating it",
    "Refining it",
    "Adjusting things",
    "Touching it up",
  ],
  apply_patch: [
    "Making changes",
    "Applying the changes",
    "Editing the code",
    "Patching it",
    "Wiring it up",
    "Putting it together",
    "Updating the code",
  ],
  str_replace: [
    "Editing",
    "Making changes",
    "Tweaking it",
    "Updating the text",
    "Swapping things out",
    "Refining it",
  ],
  grep: [
    "Searching",
    "Looking it up",
    "Scanning through",
    "Finding it",
    "Digging in",
    "Searching the files",
  ],
  glob: [
    "Looking for files",
    "Finding files",
    "Scanning the folder",
    "Searching files",
    "Tracking files down",
    "Browsing files",
  ],
  view_image: [
    "Taking a look",
    "Viewing the image",
    "Checking the image",
    "Looking at it",
    "Studying the picture",
    "Examining it",
  ],
  write_stdin: [
    "Sending input",
    "Typing it in",
    "Passing it along",
    "Feeding it in",
    "Responding",
    "Sending it over",
  ],
  tool_search: [
    "Finding the right tool",
    "Looking for tools",
    "Picking a tool",
    "Searching tools",
    "Lining up the tools",
    "Choosing how",
  ],
  request_credential: [
    "Asking for access",
    "Requesting access",
    "Getting permission",
    "Lining up access",
    "Checking access",
    "Asking to connect",
  ],
  multi_tool_use_parallel: [
    "Juggling a few things",
    "Doing several things",
    "Working in parallel",
    "Handling a few things",
    "Multitasking",
    "Running things together",
  ],
  dream: [
    "Thinking it over",
    "Mulling it over",
    "Reflecting",
    "Turning it over",
    "Working it out",
    "Connecting the dots",
  ],
  import_source: [
    "Pulling it in",
    "Importing it",
    "Bringing it in",
    "Loading the source",
    "Fetching it",
    "Reading it in",
  ],
  script_draft: [
    "Drafting",
    "Sketching it out",
    "Writing the script",
    "Putting it together",
    "Outlining it",
    "Drafting the steps",
  ],
  html: [
    "Building it",
    "Putting it together",
    "Laying it out",
    "Designing it",
    "Mocking it up",
    "Drafting the page",
  ],
  computer_use: [
    "Using the computer",
    "Working on the desktop",
    "Driving the computer",
    "Handling it",
    "On it",
  ],
  browser: [
    "Using the browser",
    "Looking it up",
    "Browsing",
    "Checking the page",
    "On it",
  ],
  task: [
    "On it",
    "Handling it",
    "Working on it",
    "Taking care of it",
    "Getting it done",
    "Making it happen",
  ],

  schedule_add: ["Scheduling it", "Setting it up", "Adding it", "Penciling it in", "Booking it"],
  schedule_list: [
    "Checking the schedule",
    "Looking at what's planned",
    "Reviewing the schedule",
    "Pulling up the schedule",
  ],
  schedule_update: ["Updating the schedule", "Adjusting it", "Rescheduling", "Tweaking the timing"],
  schedule_remove: ["Clearing it", "Removing it", "Canceling it", "Taking it off the schedule"],

  cron_add: ["Scheduling it", "Setting it up", "Adding it", "Penciling it in", "Booking it"],
  cron_list: [
    "Checking the schedule",
    "Looking at what's planned",
    "Reviewing the schedule",
    "Pulling up the schedule",
  ],
  cron_remove: ["Clearing it", "Removing it", "Canceling it", "Taking it off the schedule"],
  cron_run: ["Running it", "Kicking it off", "Triggering it", "Setting it in motion"],
  cron_update: ["Updating the schedule", "Adjusting it", "Rescheduling", "Tweaking the timing"],
  heartbeat_get: ["Checking in", "Taking a pulse", "Checking status", "Seeing how it's going"],
  heartbeat_run: ["Running a check", "Checking in", "Taking a pulse", "Testing it"],
  heartbeat_upsert: ["Saving the status", "Updating the check-in", "Logging it", "Recording it"],
};

const FALLBACK_VARIATIONS: readonly string[] = [
  "Working on it",
  "On it",
  "Just a sec",
  "One moment",
  "Handling it",
  "Looking into it",
  "On the case",
];

const RAW_TOOL_STATUS_PATTERN =
  /^(?:running|executing|calling|invoking)\s+(.+)$/i;

const toToolStatusKey = (value: string): string =>
  value
    .trim()

    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[_\s-]+/g, "_")
    .replace(/:+$/g, "")
    .toLowerCase();

const looksLikeJsonBlob = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  if (trimmed.includes("\n") && /[{[]/.test(trimmed)) return true;
  return /"(?:session_id|exit_code|wall_time_seconds|original_token_count)"\s*:/.test(
    trimmed,
  );
};

const tryFriendlyExecCommandStatus = (value: string): string | undefined => {
  if (!looksLikeJsonBlob(value)) return undefined;
  const looksLikeExecPayload =
    /"session_id"\s*:/.test(value) &&
    (/"command"\s*:/.test(value) ||
      /"exit_code"\s*:/.test(value) ||
      /"running"\s*:/.test(value));
  if (!looksLikeExecPayload) return undefined;
  try {
    const parsed = JSON.parse(value) as {
      running?: unknown;
      exit_code?: unknown;
    };
    if (
      parsed.running !== true &&
      typeof parsed.exit_code === "number" &&
      parsed.exit_code !== 0
    ) {
      return "Command failed";
    }
  } catch {

  }
  return computeWorkingIndicatorStatus({ toolName: "exec_command", seed: "" });
};

const looksLikeRawToolIdentifier = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return (
    /^[a-z][a-z0-9]*(?:_{1,2}[a-z0-9]+)+$/.test(trimmed) ||
    /^[A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+$/.test(trimmed)
  );
};

const looksLikeMachineStatus = (value: string): boolean => {
  if (looksLikeJsonBlob(value)) return true;
  if (value.length > 120) return true;
  if (value.includes("\n")) return true;
  if (looksLikeRawToolIdentifier(value)) return true;
  return false;
};

const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const pickVariation = (
  options: readonly string[],
  seed: string | undefined,
): string => {
  if (options.length === 0) return "";
  if (options.length === 1 || !seed) return options[0]!;
  return options[hashSeed(seed) % options.length]!;
};

export function normalizeDisplayStatusText(
  statusText: string | undefined,
): string | undefined {
  if (!statusText) return undefined;
  const trimmed = statusText.trim();
  if (!trimmed) return undefined;

  const execStatus = tryFriendlyExecCommandStatus(trimmed);
  if (execStatus) return execStatus;

  const match = RAW_TOOL_STATUS_PATTERN.exec(trimmed);
  if (match) {
    const rawToolName = match[1]!;
    const toolName = toToolStatusKey(rawToolName);
    if (TOOL_STATUS_BY_NAME[toolName]) {
      return computeWorkingIndicatorStatus({ toolName, seed: "" });
    }
    const firstToken = toToolStatusKey(rawToolName.split(/\s+/)[0] ?? "");
    if (firstToken && TOOL_STATUS_BY_NAME[firstToken]) {
      return computeWorkingIndicatorStatus({ toolName: firstToken, seed: "" });
    }
    if (rawToolName.includes(" ") && !looksLikeMachineStatus(rawToolName)) {
      return trimmed;
    }
    return computeWorkingIndicatorStatus({ toolName, seed: "" });
  }

  const bareToolName = toToolStatusKey(trimmed);
  if (!/\s/.test(trimmed) && TOOL_STATUS_BY_NAME[bareToolName]) {
    return computeWorkingIndicatorStatus({ toolName: bareToolName, seed: "" });
  }

  if (looksLikeMachineStatus(trimmed)) {
    return computeWorkingIndicatorStatus({ toolName: "unknown", seed: trimmed });
  }

  return trimmed;
}

export function computeWorkingIndicatorStatus({
  status,
  toolName,
  seed,
}: {
  status?: string;
  toolName?: string;
  seed?: string;
} = {}): string {
  if (status) {
    return normalizeDisplayStatusText(status) ?? status;
  }

  if (toolName) {
    const normalizedToolName = toToolStatusKey(toolName);
    const mapped = TOOL_STATUS_BY_NAME[normalizedToolName];
    if (mapped) return pickVariation(mapped, seed ?? normalizedToolName);

    return pickVariation(FALLBACK_VARIATIONS, seed ?? normalizedToolName);
  }

  return "";
}
