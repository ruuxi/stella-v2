/**
 * Where a cloud-stored pi conversation's brain runs: Stella herself, the
 * orchestrator that takes the conversation's turns. Every host shares the
 * conversation through its journal, so the brain can move between the
 * conversation's object in the cloud and one of the owner's computers, and
 * the new host carries on from the journal.
 *
 * The conversation's object keeps the record, the one place every device
 * reads (`GET|POST /conversations/:id/pi-brain`). The rule:
 *
 * - No record: Stella follows the sender. Each sender's host answers its
 *   own messages (a computer its user's, the object the phone's).
 * - A record: that host takes the conversation's turns, unless it is
 *   unavailable (a computer offline or not ready, the cloud out of reach),
 *   and then she follows the sender again. The record stays, so once that
 *   host is back it takes turns again.
 *
 * While it is available, the host a record names:
 *
 * - `cloud`: the object runs every turn. A computer sends its user's
 *   messages there as placed chats, and what its agents tell Stella (their
 *   reports and notes) as hidden ones; its own harness only imports.
 * - `device`: that computer runs every turn. The object places a message
 *   sent to it (from the phone) on that computer, and another computer
 *   places its user's messages and its agents' reports there too.
 *
 * A hand-off brief placed after a move goes to the new host as it stands:
 * the move is refused while that host can't take work, and a brief that
 * finds it gone is answered where the owner gate falls back to.
 *
 * A move is refused while the host that has the brain still runs agents,
 * whose reports would wake Stella there.
 */

export type PiBrainHost =
  | { host: "cloud" }
  | {
      host: "device";
      deviceId: string;
      /** The computer's name, for what Stella and the user are told. */
      label?: string;
    };

export type PiBrainRecord = PiBrainHost & {
  /** Counts the moves, so a host can tell a newer record from the one it read. */
  epoch: number;
  updatedAt: number;
};

/** `GET` answers the record, or `{ record: null }`; `POST` a `PiBrainHost` sets it. */
export type PiBrainResponse = { record: PiBrainRecord | null };

export const piBrainPath = (conversationId: string): string =>
  `/conversations/${encodeURIComponent(conversationId)}/pi-brain`;

export const parsePiBrainHost = (value: unknown): PiBrainHost | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.host === "cloud") return { host: "cloud" };
  if (record.host !== "device" || typeof record.deviceId !== "string") return undefined;
  const deviceId = record.deviceId.trim();
  if (!deviceId || deviceId.length > 256) return undefined;
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 200) : "";
  return { host: "device", deviceId, ...(label ? { label } : {}) };
};

/** The prompt that continues a conversation where its brain moved: Stella's brief to herself. */
export const piBrainHandoffPrompt = (from: string, brief: string): string =>
  `[You moved this chat here from ${from} with switch_destination. This is your brief, not a new message from the user.]\n\n${brief}`;
