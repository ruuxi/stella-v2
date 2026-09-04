export type Env = Cloudflare.Env & {
  /**
   * Kill switch for the resident placement. Absent or any value other than
   * `"0"` lets a Stella turn run its agent loop in this Durable Object; `"0"`
   * sends every turn down the eager-container path. The placement is recorded
   * at admission rather than re-derived later, so flipping this never
   * re-places a turn that is already running.
   */
  RESIDENT_GENERAL_AGENT_TURNS?: string;
};
