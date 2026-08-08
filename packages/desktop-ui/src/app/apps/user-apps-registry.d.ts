export type UserAppStatus =
  | "stopped"
  | "installing"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type UserAppMeta = {
  label: string;
  createdAt: string;
};

export type UserApp = {
  slug: string;
  meta: UserAppMeta;
  status: UserAppStatus;
};

export type UserAppsRegistrySnapshot = {
  phase: "loading" | "ready" | "unsupported" | "error";
  apps: readonly UserApp[];
  error: string | null;
  refreshing: boolean;
};

export declare const subscribe: (subscriber: () => void) => () => void;
export declare const getSnapshot: () => UserAppsRegistrySnapshot;
export declare const getServerSnapshot: () => UserAppsRegistrySnapshot;
export declare const getUserApp: (slug: string) => UserApp | undefined;
export declare const refreshUserApps: () => Promise<void>;
export declare const stopUserApp: (slug: string) => Promise<unknown>;
export declare const __resetUserAppsRegistryForTests: () => void;
