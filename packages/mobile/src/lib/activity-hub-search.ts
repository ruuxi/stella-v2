import type { ChatArtifact, MobileTask } from "../types";
import { artifactSubtitle, artifactTitle } from "./mobile-artifacts";

const normalize = (value: string) => value.trim().toLowerCase();

const fieldsMatch = (
  query: string,
  fields: readonly (string | undefined)[],
): boolean => {
  for (const field of fields) {
    if (field && field.toLowerCase().includes(query)) return true;
  }
  return false;
};

export function filterHubTasks(
  tasks: readonly MobileTask[],
  query: string,
): MobileTask[] {
  const q = normalize(query);
  if (!q) return [...tasks];
  return tasks.filter((task) =>
    fieldsMatch(q, [task.title, task.statusText, ...(task.reasoningSummaries ?? [])]),
  );
}

export function filterHubArtifacts(
  artifacts: readonly ChatArtifact[],
  query: string,
): ChatArtifact[] {
  const q = normalize(query);
  if (!q) return [...artifacts];
  return artifacts.filter((artifact) =>
    fieldsMatch(q, [
      artifactTitle(artifact.payload),
      artifactSubtitle(artifact.payload),
    ]),
  );
}
