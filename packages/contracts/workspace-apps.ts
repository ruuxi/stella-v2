/** Owner-scoped apps discovered from the cloud world filesystem. */
export type WorkspaceApp = {
  appId: string;
  slug: string;
  title: string;
  revision: string;
  status: "ready" | "error";
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export function parseWorkspaceApps(value: unknown): WorkspaceApp[] {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some(
      (app) =>
        !app ||
        typeof app !== "object" ||
        typeof app.slug !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(app.slug) ||
        app.appId !== app.slug ||
        typeof app.title !== "string" ||
        typeof app.revision !== "string" ||
        !["ready", "error"].includes(app.status) ||
        !Number.isFinite(app.createdAt) ||
        !Number.isFinite(app.updatedAt) ||
        (app.error !== undefined && typeof app.error !== "string"),
    )
  )
    throw new Error("Invalid app list.");
  return value;
}
