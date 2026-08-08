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

export type ToolActivityStatus = "running" | "completed" | "error";

export type ToolActivityStep = {
  id: string;
  toolName: string;
  category: ToolActivityCategory;
  title: string;
  status: ToolActivityStatus;
};

export type ToolActivityGroup = {
  steps: ToolActivityStep[];
  summary: string;
  icon: ToolActivityCategory;
};
