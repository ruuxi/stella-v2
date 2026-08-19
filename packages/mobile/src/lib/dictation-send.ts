import type { DictationStatus } from "./dictation";

export const canSubmitFinalizedDictation = (args: {
  armed: boolean;
  resultReady: boolean;
  status: DictationStatus;
  draft: string;
  target: string | null;
  attachmentCount: number;
}) =>
  args.armed &&
  args.resultReady &&
  args.status === "idle" &&
  args.target !== null &&
  args.draft === args.target &&
  (args.draft.trim().length > 0 || args.attachmentCount > 0);
