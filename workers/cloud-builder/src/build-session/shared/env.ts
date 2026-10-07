export type Env = Cloudflare.Env & {
  /**
   * Kill switch for the resident placement. Absent or any value other than
   * `"0"` lets a Stella turn run its agent loop in this Durable Object; `"0"`
   * sends every turn down the eager-container path. The placement is recorded
   * at admission rather than re-derived later, so flipping this never
   * re-places a turn that is already running.
   */
  RESIDENT_GENERAL_AGENT_TURNS?: string;
  /**
   * Idle timeout, in milliseconds, for a container a prewarm started. It only
   * has to cover the gap between admitting a turn and that turn attaching; the
   * turn's first container call raises the timeout to
   * `SANDBOX_IDLE_TIMEOUT_MS`. Absent or malformed falls back to 90s, and it is
   * never longer than `SANDBOX_IDLE_TIMEOUT_MS`.
   */
  SANDBOX_PREWARM_IDLE_TIMEOUT_MS?: string;
};
