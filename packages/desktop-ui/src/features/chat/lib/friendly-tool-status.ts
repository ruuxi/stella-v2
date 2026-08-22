import type { TaskToolActivity } from "@stella/contracts/agent-runtime";

type FriendlyToolLabels = {
  active: string;
  done: string;
  failed?: string;
};

const FRIENDLY_TOOL_LABELS: Record<string, FriendlyToolLabels> = {
  exec_command: {
    active: "Running command",
    done: "Ran command",
    failed: "Command failed",
  },
  node_repl: { active: "Running code", done: "Ran code" },
  apply_patch: { active: "Editing files", done: "Edited files" },
  edit: { active: "Editing files", done: "Edited files" },
  write: { active: "Editing files", done: "Edited files" },
  strreplace: { active: "Editing files", done: "Edited files" },
  multi_edit: { active: "Editing files", done: "Edited files" },
  write_stdin: { active: "Sending input", done: "Sent input" },
  spawn_agent: {
    active: "Starting work",
    done: "Started work",
  },
  send_input: {
    active: "Updating work",
    done: "Updated work",
  },
  pause_agent: {
    active: "Pausing work",
    done: "Paused work",
  },
  agent_status: {
    active: "Checking on work",
    done: "Checked on work",
  },
  read: { active: "Reading files", done: "Read files" },
  find: { active: "Searching files", done: "Searched files" },
  glob: { active: "Searching files", done: "Searched files" },
  grep: { active: "Searching files", done: "Searched files" },
  // legacy — tool removed; keep for old-transcript rendering.
  tool_search: { active: "Finding a tool", done: "Found a tool" },
  web: { active: "Searching the web", done: "Searched the web" },
  web_search: { active: "Searching the web", done: "Searched the web" },
  search: { active: "Searching the web", done: "Searched the web" },
  search_query: { active: "Searching the web", done: "Searched the web" },
  view_image: { active: "Viewing image", done: "Viewed image" },
  imagegen: { active: "Creating image", done: "Created image" },
  image_gen: { active: "Creating image", done: "Created image" },
  computer_use: { active: "Using the computer", done: "Used the computer" },
  browser: { active: "Using the browser", done: "Used the browser" },
};

const normalizedToolName = (toolName: string): string => {
  const namespacedParts = toolName.split("__").filter(Boolean);
  return (namespacedParts.at(-1) ?? toolName).trim().toLowerCase();
};

export const friendlyInlineToolStatus = (
  activity: TaskToolActivity,
): string => {
  const labels = FRIENDLY_TOOL_LABELS[normalizedToolName(activity.toolName)];
  const failed =
    activity.state === "completed" &&
    typeof activity.exitCode === "number" &&
    activity.exitCode !== 0;

  if (labels) {
    if (failed && labels.failed) return labels.failed;
    return activity.state === "started" ? labels.active : labels.done;
  }

  if (failed) return "A step failed";
  return activity.state === "started" ? "Working on it" : "Finished a step";
};
