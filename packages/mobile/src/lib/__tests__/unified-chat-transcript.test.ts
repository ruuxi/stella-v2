import { describe, expect, test } from "bun:test";
import {
  canonicalCloudDispatchIds,
  mergeCanonicalCloudMessages,
  projectCloudConversationMessages,
  rebindCanonicalCloudMessages,
} from "../cloud-journal-projection";
import type { JournalRecord } from "../cloud-conversation-protocol";
import type { ChatMessage } from "../../types";

const COMPUTER_DISPATCH = "exec:11111111-1111-4111-8111-111111111111";
const CLOUD_DISPATCH = "exec:22222222-2222-4222-8222-222222222222";

const prompt = (args: {
  seq: number;
  turnId: string;
  clientMsgId: string;
  text: string;
}): JournalRecord => ({
  kind: "message",
  seq: args.seq,
  turnId: args.turnId,
  role: "user",
  hidden: false,
  clientMsgId: args.clientMsgId,
  payload: { content: args.text },
  createdAtMs: args.seq * 1_000,
});

const reply = (args: {
  seq: number;
  turnId: string;
  text: string;
}): JournalRecord => ({
  kind: "message",
  seq: args.seq,
  turnId: args.turnId,
  role: "assistant",
  hidden: false,
  payload: { content: args.text },
  createdAtMs: args.seq * 1_000,
});

const finished = (args: { seq: number; turnId: string }): JournalRecord => ({
  kind: "turn",
  seq: args.seq,
  turnId: args.turnId,
  phase: "completed",
  createdAtMs: args.seq * 1_000,
});

/**
 * One conversation, two placements. The desktop's transcript writer and the
 * cloud orchestrator both stamp the turn's prompt with the placement dispatch
 * id, so these rows are what the phone actually receives either way.
 */
const twoPlacementJournal = (computerClientMsgId: string): JournalRecord[] => [
  prompt({
    seq: 1,
    turnId: "turn-computer",
    clientMsgId: computerClientMsgId,
    text: "open the file I was editing",
  }),
  reply({ seq: 2, turnId: "turn-computer", text: "Opened it." }),
  finished({ seq: 3, turnId: "turn-computer" }),
  prompt({
    seq: 4,
    turnId: "turn-cloud",
    clientMsgId: CLOUD_DISPATCH,
    text: "summarize my week",
  }),
  reply({ seq: 5, turnId: "turn-cloud", text: "Three deadlines." }),
  finished({ seq: 6, turnId: "turn-cloud" }),
];

const phoneRows: ChatMessage[] = [
  {
    id: "mobile:0000000000000001:computer",
    role: "user",
    text: "open the file I was editing",
  },
  {
    id: "mobile:0000000000000001:computer-reply",
    requestId: "mobile:0000000000000001:computer",
    role: "assistant",
    text: "",
  },
  {
    id: "mobile:0000000000000002:cloud",
    role: "user",
    text: "summarize my week",
  },
  {
    id: "mobile:0000000000000002:cloud-reply",
    requestId: "mobile:0000000000000002:cloud",
    role: "assistant",
    text: "",
  },
];

const readSurface = (args: {
  records: JournalRecord[];
  bindings: ReadonlyMap<string, string | null>;
  local?: ChatMessage[];
}) => {
  const canonical = rebindCanonicalCloudMessages(
    projectCloudConversationMessages({
      conversationId: "conv:one-chat",
      records: args.records,
    }),
    args.bindings,
  );
  return mergeCanonicalCloudMessages({
    canonical,
    local: args.local ?? phoneRows,
    dispatchBindings: args.bindings,
    acknowledgedDispatchIds: canonicalCloudDispatchIds(args.records),
  });
};

const bindings = new Map<string, string | null>([
  ["mobile:0000000000000001:computer", COMPUTER_DISPATCH],
  ["mobile:0000000000000002:cloud", CLOUD_DISPATCH],
]);

describe("the one chat's transcript", () => {
  test("reads a computer turn and a cloud turn as one conversation", () => {
    const surface = readSurface({
      records: twoPlacementJournal(COMPUTER_DISPATCH),
      bindings,
    });

    expect(surface.map((row) => [row.role, row.text] as const)).toEqual([
      ["user", "open the file I was editing"],
      ["assistant", "Opened it."],
      ["user", "summarize my week"],
      ["assistant", "Three deadlines."],
    ]);
    expect(surface.map((row) => row.sequence)).toEqual([1, 2, 4, 5]);
    // Each optimistic bubble keeps its own React identity through the handoff.
    expect(surface.map((row) => row.id)).toEqual([
      "mobile:0000000000000001:computer",
      "cloud:turn-computer:message:2",
      "mobile:0000000000000002:cloud",
      "cloud:turn-cloud:message:5",
    ]);
    // Nothing a row carries says where its turn ran.
    expect(
      surface.every((row) => !JSON.stringify(row).includes(COMPUTER_DISPATCH)),
    ).toBe(true);
  });

  test("shows the user's own words once when the computer ran the turn", () => {
    const surface = readSurface({
      records: twoPlacementJournal(COMPUTER_DISPATCH),
      bindings,
    });
    expect(
      surface.filter((row) => row.text === "open the file I was editing"),
    ).toHaveLength(1);

    // A desktop that stamped the prompt with its own local event id instead of
    // the placement dispatch id leaves the phone unable to recognize its own
    // turn, and the user sees what they typed twice.
    const mismatched = readSurface({
      records: twoPlacementJournal("local-chat-event:7"),
      bindings,
    });
    expect(
      mismatched.filter((row) => row.text === "open the file I was editing"),
    ).toHaveLength(2);
  });

  test("keeps a send still choosing its placement at the end of the transcript", () => {
    const inFlight: ChatMessage[] = [
      ...phoneRows,
      {
        id: "mobile:0000000000000003:pending",
        role: "user",
        text: "and remind me tonight",
      },
      {
        id: "mobile:0000000000000003:pending-reply",
        requestId: "mobile:0000000000000003:pending",
        role: "assistant",
        text: "",
      },
    ];
    const surface = readSurface({
      records: twoPlacementJournal(COMPUTER_DISPATCH),
      bindings: new Map([
        ...bindings,
        ["mobile:0000000000000003:pending", null],
      ]),
      local: inFlight,
    });

    expect(surface.map((row) => row.id).slice(-2)).toEqual([
      "mobile:0000000000000003:pending",
      "mobile:0000000000000003:pending-reply",
    ]);
  });

  test("never treats a leftover local row as history", () => {
    const surface = readSurface({
      records: twoPlacementJournal(COMPUTER_DISPATCH),
      bindings,
      local: [
        {
          id: "mobile:0000000000000000:before-the-journal",
          role: "user",
          text: "from a previous life",
        },
        ...phoneRows,
      ],
    });
    expect(surface.some((row) => row.text === "from a previous life")).toBe(
      false,
    );
  });
});
