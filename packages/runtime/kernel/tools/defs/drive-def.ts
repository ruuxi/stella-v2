/**
 * The `drive` tool's model-visible surface, split from the executable
 * definition so a device and a cloud session advertise the byte-identical
 * tool — the same arrangement `read-def.ts` uses, and for the same reason: a
 * sentence that is true in only one placement is how an agent ends up
 * following an instruction that cannot work where it is running.
 *
 * `fetch` answers with a path rather than bytes, which is what lets the two
 * placements share one description. Wherever the agent runs, the next step is
 * `Read` on the path it was given, over a file that is really there.
 *
 * Nothing here states a size. The readable size is a property of the session,
 * not of the placement: a resident cloud world hydrates far less than a
 * device's real filesystem holds. `fetch` reports the limit it actually hit,
 * so a refusal is accurate instead of a promise being broken.
 */

export const DRIVE_TOOL_NAME = "drive";

export const DRIVE_TOOL_DESCRIPTION =
  "Read the user's Stella Drive — the files they uploaded from any device and the files agents saved there. `list` finds files by drive path; `fetch` puts one on this machine and returns an absolute path to Read. Attachments on the current turn are already provided to you, so use this for a file nobody handed you: something attached earlier in the conversation, or saved by previous work. Read-only; it cannot write, move, or delete.";

export const DRIVE_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "fetch"],
      description:
        "`list` to find files, `fetch` to bring one here and get a path to Read.",
    },
    path: {
      type: "string",
      description:
        "fetch: the file's drive path, relative to the drive root and never absolute (`uploads/2026-08-29/photo.jpg`).",
    },
    prefix: {
      type: "string",
      description:
        "list: restrict to a drive folder (`uploads/`). Omit to list newest first across the whole drive.",
    },
    limit: { type: "number", description: "list: how many rows, default 50." },
  },
  required: ["action"],
};

/** Replay policy (`ToolReplayPolicy`). Reading the drive again has no effect. */
export const DRIVE_TOOL_REPLAY = "safe" as const;
