let projectRoot = "";

export function setGoogleWorkspaceProjectRoot(root: string): void {
  projectRoot = root;
}

export function getProjectRoot(): string {
  return projectRoot;
}
