/** Legacy transcript payload retained only for reading historical rows. */
export type SelfModApplied = {
  applyId?: string;
  changeSetId?: string;
  commitHash?: string;
  commitHashes?: string[];
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied" | "reverted";
};
