export type WorkspaceCheckpoint = {
  id: string;
  workspaceId: string;
  createdAt: number;
};

export interface WorkspaceStore {
  restore(workspaceId: string, destination: string): Promise<void>;
  checkpoint(
    workspaceId: string,
    source: string,
  ): Promise<WorkspaceCheckpoint>;
}

/**
 * M0 implementation for a newly-created workspace. M1 replaces this with the
 * R2-backed Sandbox backup adapter while retaining this interface.
 */
export class EmptyWorkspaceStore implements WorkspaceStore {
  async restore(_workspaceId: string, _destination: string): Promise<void> {}

  async checkpoint(
    workspaceId: string,
    _source: string,
  ): Promise<WorkspaceCheckpoint> {
    return {
      id: `empty:${workspaceId}`,
      workspaceId,
      createdAt: Date.now(),
    };
  }
}
