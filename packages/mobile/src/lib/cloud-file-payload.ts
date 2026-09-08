/**
 * A file the cloud journal reports (`files` card) as an openable artifact
 * payload. Every one of these lives in the owner's cloud drive, so each is
 * marked `driveBacked`: the artifact viewer resolves it through a signed
 * drive URL and never through the desktop bridge.
 */
import type { ChatArtifact, MobileDisplayPayload } from "../types";
import type { JournalFile } from "./cloud-conversation-protocol";
import { artifactId } from "./mobile-artifacts";

const titleCase = (slug: string) =>
  slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const cloudFilePayload = (
  file: JournalFile,
  createdAt: number,
): MobileDisplayPayload => {
  const path = file.path;
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension === "pdf") {
    return { kind: "pdf", filePath: path, title: file.name, driveBacked: true };
  }
  if (extension === "html" || extension === "htm") {
    // A cloud `html` canvas: the orchestrator wrote it into the drive.
    const slug = file.name.replace(/\.html?$/i, "");
    return {
      kind: "canvas-html",
      filePath: path,
      title: titleCase(slug),
      slug,
      createdAt,
      driveBacked: true,
    };
  }
  if (extension === "md" || extension === "markdown") {
    return {
      kind: "markdown",
      filePath: path,
      title: file.name,
      createdAt,
      driveBacked: true,
    };
  }
  if (
    ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "tsv"].includes(
      extension,
    )
  ) {
    const artifactKind =
      extension === "csv" || extension === "tsv"
        ? "delimited-table"
        : extension.startsWith("xls")
          ? "office-spreadsheet"
          : extension.startsWith("ppt")
            ? "office-slides"
            : "office-document";
    return {
      kind: "file-artifact",
      filePath: path,
      artifactKind,
      title: file.name,
      createdAt,
      driveBacked: true,
    };
  }
  return {
    kind: "media",
    asset: { kind: "download", filePath: path, label: file.name },
    createdAt,
    driveBacked: true,
  };
};

/**
 * The openable artifact for one journal file. Ids are the path-keyed
 * `artifactId`, so the same file dedupes between a completion card's
 * section, the row's loose artifacts, and the activity hub's file list.
 */
export const cloudFileArtifact = (
  file: JournalFile,
  conversationId: string,
  createdAt: number,
): ChatArtifact => {
  const payload = cloudFilePayload(file, createdAt);
  return { id: artifactId(payload, conversationId), conversationId, payload };
};
