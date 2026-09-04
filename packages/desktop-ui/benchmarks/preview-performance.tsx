/** Synthetic file transport; real preview components, worker, CSS, and scrolling.
 * Open /benchmarks/preview-performance.html on the desktop Vite server.
 * This measures renderer work; it does not certify Electron IPC or file selection.
 */
import { LocalI18nProvider } from "../src/shared/i18n/I18nProvider";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DelimitedTableTabContent,
  SourceDiffTabContent,
} from "../src/shell/display/tab-content";
import { sourceDiffBatches } from "../src/features/workspace-display/source-diff-batches";
import "../src/shell/right-sidebar.css";

const csv = new TextEncoder().encode(
  "x,".repeat(9_999) +
    "x\n" +
    Array.from({ length: 999 }, (_, i) => `row${i},value\n`).join(""),
);
const source = new TextEncoder().encode(
  Array.from(
    { length: 100_000 },
    (_, i) => `export const item${i} = ${i};\n`,
  ).join(""),
);
const reads: { filePath: string; bytes: number; maxBytes?: number }[] = [];
Object.defineProperty(window, "electronAPI", {
  value: {
    display: {
      readFile: async (filePath: string, options: { maxBytes?: number }) => {
        const all = filePath.endsWith(".csv") ? csv : source;
        const bytes = all.slice(0, options.maxBytes ?? all.length);
        reads.push({
          filePath,
          bytes: bytes.length,
          maxBytes: options.maxBytes,
        });
        const output = document.getElementById("fixture-reads");
        if (output) output.textContent = JSON.stringify(reads);
        return {
          bytes,
          truncated: bytes.length < all.length,
          mimeType: "text/plain",
          path: filePath,
        };
      },
    },
  },
  configurable: true,
});
function Fixture() {
  const [mode, setMode] = useState("");
  return (
    <main style={{ width: 700, padding: 20, font: "14px system-ui" }}>
      <h1>Preview performance fixture</h1>
      <output id="fixture-reads" style={{ display: "block", fontSize: 10 }} />
      <button onClick={() => setMode("csv")}>Open wide CSV</button>
      <button
        onClick={() => {
          sourceDiffBatches.push({
            id: "fixture",
            label: "Large source fixture",
            createdAt: 1,
            payloads: [
              {
                kind: "source-diff",
                filePath: "/fixture/large.ts",
                createdAt: 1,
              },
            ],
          });
          setMode("diff");
        }}
      >
        Open large diff
      </button>
      {mode === "csv" && (
        <DelimitedTableTabContent filePath="/fixture/wide.csv" />
      )}
      {mode === "diff" && <SourceDiffTabContent />}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <LocalI18nProvider>
    <Fixture />
  </LocalI18nProvider>,
);
