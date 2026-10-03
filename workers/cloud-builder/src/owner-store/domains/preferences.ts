/**
 * Account preferences, and feedback (stored globally in D1).
 *
 * Feedback is owner-scoped only so it can share the owner's rate limiter;
 * nothing about the sender is written with it.
 */

import {
  FEEDBACK_MAX_CHARS,
  PREFERENCE_LOCALES,
  PREFERRED_BROWSERS,
  type PreferenceCalls,
  type PreferenceLocale,
  type Preferences,
  type PreferredBrowser,
} from "@stella/contracts/backend/preferences";
import { empty, literal, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";

const LOCALE_KEY = "locale";
const PREFERRED_BROWSER_KEY = "preferred_browser";
const FEEDBACK_META_MAX_CHARS = 64;

export const PREFERENCES_MIGRATION = {
  id: "preferences.1-init",
  statements: [
    `CREATE TABLE preferences (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  ],
};

const isLocale = (value: string | null | undefined): value is PreferenceLocale =>
  typeof value === "string" && (PREFERENCE_LOCALES as readonly string[]).includes(value);

const isBrowser = (value: string | null | undefined): value is PreferredBrowser =>
  typeof value === "string" && (PREFERRED_BROWSERS as readonly string[]).includes(value);

const readPreferences = (db: OwnerDbReader): Preferences => {
  const values = new Map(
    db
      .all<{ key: string; value: string }>("SELECT key, value FROM preferences")
      .map((row) => [row.key, row.value]),
  );
  const locale = values.get(LOCALE_KEY);
  const browser = values.get(PREFERRED_BROWSER_KEY);
  return {
    locale: isLocale(locale) ? locale : null,
    preferredBrowser: isBrowser(browser) ? browser : null,
  };
};

const setPreferences = (
  ctx: OwnerContext,
  args: PreferenceCalls["preferences.set"]["args"],
): Preferences => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "preferences.set",
    { count: 60, windowMs: 60_000 },
    "Too many settings changes. Please wait a moment.",
  );
  const write = (key: string, value: string) =>
    ctx.db.run(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      ctx.now,
    );
  if (args.locale !== undefined) write(LOCALE_KEY, args.locale);
  if (args.preferredBrowser !== undefined) write(PREFERRED_BROWSER_KEY, args.preferredBrowser);
  return readPreferences(ctx.db);
};

const submitFeedback = async (
  ctx: OwnerContext,
  args: PreferenceCalls["feedback.submit"]["args"],
): Promise<null> => {
  const message = args.message.trim();
  if (!message) throw new RpcError("BAD_REQUEST", "Feedback can't be empty.");
  if (message.length > FEEDBACK_MAX_CHARS) {
    throw new RpcError("BAD_REQUEST", `Feedback is limited to ${FEEDBACK_MAX_CHARS} characters.`);
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "feedback.submit",
    { count: 10, windowMs: 60_000 },
    "Too many feedback submissions. Please try again in a minute.",
  );
  const database = ctx.env.DB;
  if (!database) throw new RpcError("UNAVAILABLE", "Feedback isn't available right now.");
  const appVersion = args.appVersion?.trim().slice(0, FEEDBACK_META_MAX_CHARS) || null;
  const platform = args.platform?.trim().slice(0, FEEDBACK_META_MAX_CHARS) || null;
  await database
    .prepare(
      "INSERT INTO feedback (id, message, app_version, platform, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), message, appVersion, platform, ctx.now)
    .run();
  return null;
};

export const preferencesDomain = {
  name: "preferences",
  migrations: [PREFERENCES_MIGRATION],
  views: {
    "preferences.get": {
      parse: empty(),
      read: (ctx) => readPreferences(ctx.db),
    },
  },
  calls: {
    "preferences.set": {
      scope: "owner",
      parse: object({
        locale: optional(literal(...PREFERENCE_LOCALES)),
        preferredBrowser: optional(literal(...PREFERRED_BROWSERS)),
      }),
      handler: (ctx: OwnerContext, args: PreferenceCalls["preferences.set"]["args"]) =>
        setPreferences(ctx, args),
    },
    "feedback.submit": {
      scope: "owner",
      parse: object({
        message: string({ max: FEEDBACK_MAX_CHARS * 2 }),
        appVersion: optional(string({ max: 1_000 })),
        platform: optional(string({ max: 1_000 })),
      }),
      handler: (ctx: OwnerContext, args: PreferenceCalls["feedback.submit"]["args"]) =>
        submitFeedback(ctx, args),
    },
  },
  purge: (ctx) => {
    ctx.db.run("DELETE FROM preferences");
    return { pending: false };
  },
} satisfies OwnerDomain;
