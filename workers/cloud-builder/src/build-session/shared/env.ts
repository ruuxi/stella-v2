export type Env = Cloudflare.Env & {
  /**
   * Idle timeout, in milliseconds, for a container a prewarm started. It only
   * has to cover the gap between admitting a turn and that turn attaching; the
   * turn's first container call raises the timeout to
   * `SANDBOX_IDLE_TIMEOUT_MS`. Absent or malformed falls back to 90s, and it is
   * never longer than `SANDBOX_IDLE_TIMEOUT_MS`.
   */
  SANDBOX_PREWARM_IDLE_TIMEOUT_MS?: string;
};
