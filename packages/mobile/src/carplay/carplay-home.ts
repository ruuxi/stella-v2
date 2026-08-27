export type CarPlayPhase = "idle" | "listening" | "thinking" | "speaking";

export type RecentReply = {
  id: string;
  text: string;

  at: number;
};

export const RECENT_REPLY_COUNT = 2;

export type CarPlayHomeState = {
  phase: CarPlayPhase;

  speakingPreview: string;

  replies: RecentReply[];

  newReplyId: string | null;

  converseOn: boolean;

  target: "phone" | "computer";

  targetSelectable: boolean;

  now: number;
};

export type HomeRowAction =
  | { kind: "talk" }
  | { kind: "readReply"; id: string }
  | { kind: "readLatest" }
  | { kind: "toggleConverse" }
  | { kind: "toggleTarget" };

export type HomeRowSpec = {
  text: string;
  detailText: string;
  isPlaying?: boolean;
};

export type HomeRow = { item: HomeRowSpec; action: HomeRowAction };

export type HomeSection = { header?: string; rows: HomeRow[] };

const TALK_COPY: Record<CarPlayPhase, { title: string; subtitle: string }> = {
  idle: { title: "Talk to Stella", subtitle: "Tap to speak — hands free" },
  listening: { title: "Listening…", subtitle: "Tap to stop and send" },
  thinking: { title: "Stella is thinking…", subtitle: "One moment" },
  speaking: { title: "Stella is speaking", subtitle: "Tap to interrupt and talk" },
};

export function previewText(text: string, max = 100): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function buildTalkRow(state: CarPlayHomeState): HomeRow {
  const copy = TALK_COPY[state.phase];
  return {
    item: {
      text: copy.title,
      detailText:
        state.phase === "speaking" && state.speakingPreview
          ? previewText(state.speakingPreview)
          : copy.subtitle,
      isPlaying: state.phase === "listening" || state.phase === "thinking",
    },
    action: { kind: "talk" },
  };
}

export function formatRelativeTime(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function buildReplyRows(state: CarPlayHomeState): HomeRow[] {
  return state.replies.slice(0, RECENT_REPLY_COUNT).map((reply) => {
    const isNew = reply.id === state.newReplyId;
    const when = formatRelativeTime(reply.at, state.now);
    return {
      item: {
        text: previewText(reply.text),
        detailText: isNew ? `New · ${when} — tap to hear it` : when,
        isPlaying: false,
      },
      action: { kind: "readReply", id: reply.id },
    };
  });
}

export function buildReadLatestRow(state: CarPlayHomeState): HomeRow | null {
  const newest = state.replies[0];
  if (!newest) return null;
  return {
    item: {
      text: "Read latest reply",
      detailText: previewText(newest.text, 80),
    },
    action: { kind: "readLatest" },
  };
}

export function buildConverseRow(state: CarPlayHomeState): HomeRow {
  return {
    item: {
      text: `Converse mode: ${state.converseOn ? "On" : "Off"}`,
      detailText: state.converseOn
        ? "Replies play aloud automatically — tap to turn off"
        : "Tap to hear replies automatically",
    },
    action: { kind: "toggleConverse" },
  };
}

export function buildTargetRow(state: CarPlayHomeState): HomeRow | null {
  if (!state.targetSelectable) return null;
  const onComputer = state.target === "computer";
  return {
    item: {
      text: `Send to: ${onComputer ? "Computer" : "Phone"}`,
      detailText: onComputer
        ? "Messages go to your computer's chat — tap to use this phone"
        : "Messages stay in this phone's chat — tap to use your computer",
    },
    action: { kind: "toggleTarget" },
  };
}

export function buildHome(state: CarPlayHomeState): HomeSection[] {
  const firstRows: HomeRow[] = [buildTalkRow(state)];
  const readLatest = buildReadLatestRow(state);
  if (readLatest) firstRows.push(readLatest);
  firstRows.push(buildConverseRow(state));
  const targetRow = buildTargetRow(state);
  if (targetRow) firstRows.push(targetRow);
  const sections: HomeSection[] = [{ rows: firstRows }];
  const replyRows = buildReplyRows(state);
  if (replyRows.length > 0) {
    sections.push({ header: "Recent replies", rows: replyRows });
  }
  return sections;
}

export function flattenActions(sections: HomeSection[]): HomeRowAction[] {
  return sections.flatMap((section) => section.rows.map((row) => row.action));
}

export function parseTemplateConfig(
  config: unknown,
  resolveImage: (source: unknown) => unknown,
): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        if (/[Ii]mage$/.test(key) && value != null) {
          out[key] = resolveImage(value);
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    }
    return node;
  };
  return JSON.parse(JSON.stringify(walk(config)));
}
