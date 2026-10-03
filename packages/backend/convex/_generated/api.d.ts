/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account_deletion from "../account_deletion.js";
import type * as anon_cleanup from "../anon_cleanup.js";
import type * as app_integrity from "../app_integrity.js";
import type * as app_integrity_node from "../app_integrity_node.js";
import type * as auth from "../auth.js";
import type * as auth_account_deletion from "../auth_account_deletion.js";
import type * as auth_migration from "../auth_migration.js";
import type * as billing_bridge from "../billing_bridge.js";
import type * as cloud_purge from "../cloud_purge.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as http_routes_admin from "../http_routes/admin.js";
import type * as http_routes_app_integrity from "../http_routes/app_integrity.js";
import type * as http_routes_auth_handoff from "../http_routes/auth_handoff.js";
import type * as http_routes_gateway from "../http_routes/gateway.js";
import type * as http_shared_admin from "../http_shared/admin.js";
import type * as http_shared_better_auth_response from "../http_shared/better_auth_response.js";
import type * as http_shared_cors from "../http_shared/cors.js";
import type * as http_shared_request from "../http_shared/request.js";
import type * as http_shared_test_accounts from "../http_shared/test_accounts.js";
import type * as http_shared_webhook_controls from "../http_shared/webhook_controls.js";
import type * as lib_app_integrity from "../lib/app_integrity.js";
import type * as lib_auth_ip_rate_limit from "../lib/auth_ip_rate_limit.js";
import type * as lib_auth_migration_paths from "../lib/auth_migration_paths.js";
import type * as lib_browser_auth_callback from "../lib/browser_auth_callback.js";
import type * as lib_builder_turns from "../lib/builder_turns.js";
import type * as lib_cloud_execution from "../lib/cloud_execution.js";
import type * as lib_crypto_utils from "../lib/crypto_utils.js";
import type * as lib_dev_apps_host_origin from "../lib/dev_apps_host_origin.js";
import type * as lib_disposable_email_domains from "../lib/disposable_email_domains.js";
import type * as lib_email_i18n from "../lib/email_i18n.js";
import type * as lib_email_templates from "../lib/email_templates.js";
import type * as lib_expo_oauth_proxy from "../lib/expo_oauth_proxy.js";
import type * as lib_handoff_crypto from "../lib/handoff_crypto.js";
import type * as lib_http_utils from "../lib/http_utils.js";
import type * as lib_identity_level from "../lib/identity_level.js";
import type * as lib_mobile_auth_link from "../lib/mobile_auth_link.js";
import type * as lib_native_ott_redirect from "../lib/native_ott_redirect.js";
import type * as lib_owner_migration_purge from "../lib/owner_migration_purge.js";
import type * as lib_owner_snapshot_notify from "../lib/owner_snapshot_notify.js";
import type * as lib_ownership_migration_status from "../lib/ownership_migration_status.js";
import type * as lib_rate_limits from "../lib/rate_limits.js";
import type * as lib_turnstile from "../lib/turnstile.js";
import type * as mobile_auth from "../mobile_auth.js";
import type * as owner_lifecycle from "../owner_lifecycle.js";
import type * as owner_origins from "../owner_origins.js";
import type * as owner_snapshot from "../owner_snapshot.js";
import type * as rate_limits from "../rate_limits.js";
import type * as reset from "../reset.js";
import type * as schema_abuse from "../schema/abuse.js";
import type * as schema_auth from "../schema/auth.js";
import type * as schema_owner_lifecycle from "../schema/owner_lifecycle.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account_deletion: typeof account_deletion;
  anon_cleanup: typeof anon_cleanup;
  app_integrity: typeof app_integrity;
  app_integrity_node: typeof app_integrity_node;
  auth: typeof auth;
  auth_account_deletion: typeof auth_account_deletion;
  auth_migration: typeof auth_migration;
  billing_bridge: typeof billing_bridge;
  cloud_purge: typeof cloud_purge;
  crons: typeof crons;
  http: typeof http;
  "http_routes/admin": typeof http_routes_admin;
  "http_routes/app_integrity": typeof http_routes_app_integrity;
  "http_routes/auth_handoff": typeof http_routes_auth_handoff;
  "http_routes/gateway": typeof http_routes_gateway;
  "http_shared/admin": typeof http_shared_admin;
  "http_shared/better_auth_response": typeof http_shared_better_auth_response;
  "http_shared/cors": typeof http_shared_cors;
  "http_shared/request": typeof http_shared_request;
  "http_shared/test_accounts": typeof http_shared_test_accounts;
  "http_shared/webhook_controls": typeof http_shared_webhook_controls;
  "lib/app_integrity": typeof lib_app_integrity;
  "lib/auth_ip_rate_limit": typeof lib_auth_ip_rate_limit;
  "lib/auth_migration_paths": typeof lib_auth_migration_paths;
  "lib/browser_auth_callback": typeof lib_browser_auth_callback;
  "lib/builder_turns": typeof lib_builder_turns;
  "lib/cloud_execution": typeof lib_cloud_execution;
  "lib/crypto_utils": typeof lib_crypto_utils;
  "lib/dev_apps_host_origin": typeof lib_dev_apps_host_origin;
  "lib/disposable_email_domains": typeof lib_disposable_email_domains;
  "lib/email_i18n": typeof lib_email_i18n;
  "lib/email_templates": typeof lib_email_templates;
  "lib/expo_oauth_proxy": typeof lib_expo_oauth_proxy;
  "lib/handoff_crypto": typeof lib_handoff_crypto;
  "lib/http_utils": typeof lib_http_utils;
  "lib/identity_level": typeof lib_identity_level;
  "lib/mobile_auth_link": typeof lib_mobile_auth_link;
  "lib/native_ott_redirect": typeof lib_native_ott_redirect;
  "lib/owner_migration_purge": typeof lib_owner_migration_purge;
  "lib/owner_snapshot_notify": typeof lib_owner_snapshot_notify;
  "lib/ownership_migration_status": typeof lib_ownership_migration_status;
  "lib/rate_limits": typeof lib_rate_limits;
  "lib/turnstile": typeof lib_turnstile;
  mobile_auth: typeof mobile_auth;
  owner_lifecycle: typeof owner_lifecycle;
  owner_origins: typeof owner_origins;
  owner_snapshot: typeof owner_snapshot;
  rate_limits: typeof rate_limits;
  reset: typeof reset;
  "schema/abuse": typeof schema_abuse;
  "schema/auth": typeof schema_auth;
  "schema/owner_lifecycle": typeof schema_owner_lifecycle;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
};
