let projectRoot = "";

/** Stella sets this to `<stellaDataDir>/microsoft-graph` before loading Microsoft Graph tools. */
export function setMicrosoftGraphProjectRoot(root: string): void {
  projectRoot = root;
}

export function getProjectRoot(): string {
  return projectRoot;
}
