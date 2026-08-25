export type UserAppProjectStatus =
  | "stopped"
  | "installing"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type UserAppProjectMeta = {
  label: string;
  createdAt: string;
};

export type UserAppProjectDescriptor = {
  slug: string;
  meta: UserAppProjectMeta;
  status?: UserAppProjectStatus;
};

export type UserAppProjectListResult = {
  apps: UserAppProjectDescriptor[];
};

export type UserAppProjectStartResult = {
  slug: string;
  url: string | null;
  status: UserAppProjectStatus;
  error?: string;
};

export type UserAppProjectStopResult = {
  slug: string;
  status: "stopped";
};
