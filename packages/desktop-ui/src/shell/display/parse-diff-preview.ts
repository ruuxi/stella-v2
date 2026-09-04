export type DiffLine = {
  kind: "add" | "delete" | "context" | "meta";
  text: string;
};

export type DiffSection = {
  title: string;
  lines: DiffLine[];
};

export const parseApplyPatchPreview = (patch: string): DiffSection[] => {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  const ensure = (title: string) => {
    if (!current || current.title !== title) {
      current = { title, lines: [] };
      sections.push(current);
    }
    return current;
  };

  for (const rawLine of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine.startsWith("*** Add File: ")) {
      ensure(rawLine.slice("*** Add File: ".length));
      continue;
    }
    if (rawLine.startsWith("*** Update File: ")) {
      ensure(rawLine.slice("*** Update File: ".length));
      continue;
    }
    if (rawLine.startsWith("*** Delete File: ")) {
      ensure(rawLine.slice("*** Delete File: ".length));
      continue;
    }
    if (!current) continue;
    const section: DiffSection = current;
    if (rawLine.startsWith("@@") || rawLine.startsWith("*** Move to: ")) {
      section.lines.push({ kind: "meta", text: rawLine });
      continue;
    }
    if (rawLine.startsWith("+")) {
      section.lines.push({ kind: "add", text: rawLine.slice(1) });
      continue;
    }
    if (rawLine.startsWith("-")) {
      section.lines.push({ kind: "delete", text: rawLine.slice(1) });
      continue;
    }
    if (rawLine.startsWith(" ")) {
      section.lines.push({ kind: "context", text: rawLine.slice(1) });
    }
  }
  return sections.filter((section) => section.lines.length > 0);
};

export const buildGeneratedFilePreview = (
  filePath: string,
  text: string,
): DiffSection[] => [
  {
    title: filePath,
    lines: text
      .split("\n")
      .map((line): DiffLine => ({ kind: "add", text: line })),
  },
];
