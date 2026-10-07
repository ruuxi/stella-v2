/**
 * Reading across deployed versions. A migration ledger is persistent, so a
 * Worker version serving behind a migration that dropped a column or table
 * cannot restore it by re-running initialization — its reads fail for as long
 * as it serves, which is the whole window of a rollback. A read wrapped here
 * degrades to its sane default instead of failing the owner view around it.
 *
 * Use it where a drop could plausibly race a rollback: sections of a view that
 * a recent migration reshaped. A read of long-settled schema should still fail
 * loudly, because there it means a real bug.
 */

const MISSING_SCHEMA = /no such (?:table|column)/i;

/** A SQLite error from schema this version expects but the database lacks. */
export const isMissingSchema = (error: unknown): boolean =>
  error instanceof Error && MISSING_SCHEMA.test(error.message);

export const readOrDefault = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch (error) {
    if (isMissingSchema(error)) return fallback;
    throw error;
  }
};
