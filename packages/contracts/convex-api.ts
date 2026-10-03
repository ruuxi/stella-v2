import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";

export const api: PublicApiType = anyApi as unknown as PublicApiType;

export type PublicApiType = {
  "auth": {
    "getAuthUser": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getCurrentUser": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "revokeActiveSessions": FunctionReference<'action', 'public', {}, any, string | undefined>;
  };
  "auth_migration": {
    "getMyOwnershipMigrationStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "retryMyLatestFailedOwnershipMigration": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
  };
} & Record<string, any>;
