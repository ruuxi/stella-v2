import { cn } from "@/shared/lib/utils";
import {
  Archive,
  Code,
  File,
  FileSpreadsheet,
  FileText,
  Music,
  Video,
} from "@/ui/icons";
import { getElectronApi } from "@/platform/electron/electron";

export function resolveFileCategory(mimeType, name) {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (
    mimeType.includes("zip") || mimeType.includes("tar") ||
    mimeType.includes("gzip") || mimeType.includes("rar") || mimeType.includes("7z")
  ) return "archive";
  if (
    mimeType.includes("spreadsheet") || mimeType.includes("csv") ||
    /\.(?:xlsx?|csv|tsv|ods)$/i.test(name)
  ) return "spreadsheet";
  if (
    mimeType.includes("document") || mimeType.includes("msword") ||
    mimeType.includes("text/plain") || mimeType.includes("text/markdown") ||
    mimeType.includes("rtf") || /\.(?:docx?|txt|md|rtf|odt|pages)$/i.test(name)
  ) return "document";
  if (
    mimeType.includes("javascript") || mimeType.includes("typescript") ||
    mimeType.includes("json") || mimeType.includes("xml") ||
    mimeType.includes("html") || mimeType.includes("css") ||
    mimeType.includes("python") || mimeType.includes("java") ||
    mimeType.includes("x-sh") ||
    /\.(?:js|jsx|ts|tsx|py|rb|rs|go|c|cpp|h|swift|kt|java|json|yaml|yml|toml|sh|bash|zsh|css|scss|html|xml|sql|lua|r|php)$/i.test(name)
  ) return "code";
  return "file";
}

export function FileIcon({ category }) {
  const shared = { size: 16, strokeWidth: 1.75 };
  switch (category) {
    case "pdf":
      return <FileText {...shared} />;
    case "document":
      return <FileText {...shared} />;
    case "spreadsheet":
      return <FileSpreadsheet {...shared} />;
    case "code":
      return <Code {...shared} />;
    case "archive":
      return <Archive {...shared} />;
    case "audio":
      return <Music {...shared} />;
    case "video":
      return <Video {...shared} />;
    default:
      return <File {...shared} />;
  }
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FILE_NAME_MAX_CHARS = 12;

export function truncateFileName(name, max = FILE_NAME_MAX_CHARS) {
  if (name.length <= max) return name;
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0 && dotIdx >= name.length - 6) {
    const ext = name.slice(dotIdx);
    const stemBudget = max - ext.length - 1;
    if (stemBudget >= 1) {
      return `${name.slice(0, stemBudget)}…${ext}`;
    }
  }
  return `${name.slice(0, max)}…`;
}

const FILE_CATEGORY_LABELS = {
  pdf: "PDF",
  document: "Document",
  spreadsheet: "Spreadsheet",
  code: "Code file",
  archive: "Archive",
  audio: "Audio",
  video: "Video",
  file: "File",
};

export function fileAttachmentTypeLabel(mimeType = "") {
  return FILE_CATEGORY_LABELS[resolveFileCategory(mimeType, "")];
}

const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|heic|heif)$/i;

export function isImageAttachment(attachment, safeUrl) {
  if (attachment.kind === "file") return false;
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType) return mimeType.startsWith("image/");
  if (safeUrl.startsWith("data:")) {
    return /^data:image\//i.test(safeUrl);
  }

  if (attachment.name && /\.[a-z0-9]+$/i.test(attachment.name)) {
    return IMAGE_FILE_EXT_RE.test(attachment.name);
  }
  return true;
}

export function getFileAttachmentName(attachment) {
  if (attachment.name) return attachment.name;
  if (attachment.kind && attachment.kind !== "file") {
    const normalized = attachment.kind.replace(/[_-]+/g, " ").trim();
    if (normalized.length > 0) {
      return normalized[0].toUpperCase() + normalized.slice(1);
    }
  }
  return fileAttachmentTypeLabel(attachment.mimeType);
}

export function FileAttachmentChip({
  name,
  size,
  mimeType,
  path,
  chipClassName,
  removeButton,
}) {
  const category = resolveFileCategory(mimeType ?? "", name);

  const canOpen = Boolean(path);
  return (
    <span className="composer-chip-shell">
      <button
        type="button"
        className={cn(
          "chat-composer-file-chip",
          chipClassName,
          canOpen && "composer-chip-previewable",
        )}
        title={canOpen ? `${name} — click to open` : name}
        onClick={
          canOpen
            ? () => {
                void getElectronApi()?.system?.openPath?.(path);
              }
            : undefined
        }
      >
        <div className="chat-composer-file-icon">
          <FileIcon category={category} />
        </div>
        <div className="chat-composer-file-info">
          <span className="chat-composer-file-name">{truncateFileName(name)}</span>
          {typeof size === "number" && size > 0 ? (
            <span className="chat-composer-file-size">{formatFileSize(size)}</span>
          ) : null}
        </div>
      </button>
      {removeButton ?? null}
    </span>
  );
}
