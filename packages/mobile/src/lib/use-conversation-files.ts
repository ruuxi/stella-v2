import { useCallback, useEffect, useRef, useState } from "react";
import { InteractionManager } from "react-native";
import {
  DEVICE_FILE_COPY_LIMITS,
  pickDeviceFileLocation,
} from "@stella/contracts/device-files";
import { getBackendClient } from "./backend";
import {
  conversationFilesFromEntries,
  type ConversationFile,
} from "./conversation-files";
import {
  readArchivedEntries,
  readResidentFileEntries,
  readResidentWindow,
} from "./conversation-files-api";
import { listExecutionDevices } from "./execution-placement";

const REFRESH_DEBOUNCE_MS = 900;
const ARCHIVE_BATCHES_PER_PAGE = 6;

type Cursor =
  | { phase: "resident"; lowestSeq: number; beforeSeq: number }
  | { phase: "archive"; beforeSeq: number }
  | { phase: "done" };

export type ConversationFilesState = {
  files: ConversationFile[];
  /** True until the first page of the journal has answered. */
  loading: boolean;
  /** False when the journal could not be read; the chat's own files still show. */
  available: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  /** Device id → the name the owner's device list gives it. */
  deviceNames: ReadonlyMap<string, string>;
};

const mergeNewer = (
  current: readonly ConversationFile[],
  newer: readonly ConversationFile[],
): ConversationFile[] => {
  if (newer.length === 0) return current as ConversationFile[];
  const keys = new Set(newer.map((file) => file.key));
  return [...newer, ...current.filter((file) => !keys.has(file.key))];
};

const mergeOlder = (
  current: readonly ConversationFile[],
  older: readonly ConversationFile[],
): ConversationFile[] => {
  if (older.length === 0) return current as ConversationFile[];
  const keys = new Set(current.map((file) => file.key));
  const added = older.filter((file) => !keys.has(file.key));
  return added.length ? [...current, ...added] : (current as ConversationFile[]);
};

/**
 * The conversation's files, newest first, read from its cloud journal while
 * the Files page is open. `revision` changes whenever the chat gains a
 * message, which pulls in only the rows written since the last read.
 */
export function useConversationFiles(
  conversationId: string | null,
  revision: string | null,
): ConversationFilesState {
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [available, setAvailable] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<Cursor>({ phase: "done" });
  const [deviceNames, setDeviceNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const headSeq = useRef(-1);
  const busy = useRef(false);
  const generation = useRef(0);
  const located = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    void listExecutionDevices()
      .then((devices) => {
        if (cancelled) return;
        const names = new Map<string, string>();
        for (const device of devices) {
          const label = device.label?.trim();
          if (label) names.set(device.deviceId, label);
        }
        setDeviceNames(names);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = conversationId;
    const run = ++generation.current;
    setFiles([]);
    setCursor({ phase: "done" });
    setAvailable(true);
    headSeq.current = -1;
    located.current = new Set();
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const task = InteractionManager.runAfterInteractions(() => {
      void (async () => {
        try {
          const window = await readResidentWindow(id, controller.signal);
          if (run !== generation.current) return;
          if (!window) {
            setLoading(false);
            return;
          }
          const page = await readResidentFileEntries(
            id,
            { afterSeq: window.lowestSeq - 1, beforeSeq: window.headSeq + 1 },
            controller.signal,
          );
          if (run !== generation.current) return;
          headSeq.current = window.headSeq;
          setFiles(conversationFilesFromEntries(page.entries, id));
          const lowestRead = page.entries.reduce(
            (lowest, entry) => Math.min(lowest, entry.seq),
            window.headSeq + 1,
          );
          setCursor(
            page.full
              ? { phase: "resident", lowestSeq: window.lowestSeq, beforeSeq: lowestRead }
              : window.lowestSeq > 0
                ? { phase: "archive", beforeSeq: window.lowestSeq }
                : { phase: "done" },
          );
        } catch {
          if (run === generation.current) setAvailable(false);
        } finally {
          if (run === generation.current) setLoading(false);
        }
      })();
    });
    return () => {
      controller.abort();
      task.cancel();
    };
  }, [conversationId]);

  useEffect(() => {
    const id = conversationId;
    if (!id || !revision) return;
    const run = generation.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (headSeq.current < 0) return;
      void (async () => {
        try {
          const window = await readResidentWindow(id, controller.signal);
          if (!window || window.headSeq <= headSeq.current) return;
          const page = await readResidentFileEntries(
            id,
            { afterSeq: headSeq.current, beforeSeq: window.headSeq + 1 },
            controller.signal,
          );
          if (run !== generation.current) return;
          headSeq.current = window.headSeq;
          const newer = conversationFilesFromEntries(page.entries, id);
          setFiles((current) => mergeNewer(current, newer));
        } catch {
          // The next message tries again.
        }
      })();
    }, REFRESH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [conversationId, revision]);

  const loadMore = useCallback(() => {
    const id = conversationId;
    if (!id || busy.current || cursor.phase === "done") return;
    busy.current = true;
    setLoadingMore(true);
    const run = generation.current;
    void (async () => {
      let next: Cursor = cursor;
      const found: ConversationFile[] = [];
      try {
        if (next.phase === "resident") {
          const page = await readResidentFileEntries(id, {
            afterSeq: next.lowestSeq - 1,
            beforeSeq: next.beforeSeq,
          });
          found.push(...conversationFilesFromEntries(page.entries, id));
          const lowestRead = page.entries.reduce(
            (lowest, entry) => Math.min(lowest, entry.seq),
            next.beforeSeq,
          );
          next = page.full
            ? { ...next, beforeSeq: lowestRead }
            : next.lowestSeq > 0
              ? { phase: "archive", beforeSeq: next.lowestSeq }
              : { phase: "done" };
        } else {
          for (
            let batch = 0;
            batch < ARCHIVE_BATCHES_PER_PAGE && next.phase === "archive";
            batch += 1
          ) {
            const page = await readArchivedEntries(id, next.beforeSeq);
            found.push(...conversationFilesFromEntries(page.entries, id));
            next =
              page.nextBeforeSeq === null
                ? { phase: "done" }
                : { phase: "archive", beforeSeq: page.nextBeforeSeq };
            if (found.length > 0) break;
          }
        }
      } catch {
        next = { phase: "done" };
      }
      if (run !== generation.current) return;
      setFiles((current) => mergeOlder(current, found));
      setCursor(next);
    })().finally(() => {
      busy.current = false;
      if (run === generation.current) setLoadingMore(false);
    });
  }, [conversationId, cursor]);

  useEffect(() => {
    const unknown = files.filter(
      (file) =>
        file.source.kind === "computer" &&
        file.source.deviceId === null &&
        !located.current.has(file.key),
    );
    if (unknown.length === 0) return;
    for (const file of unknown) located.current.add(file.key);
    const run = generation.current;
    const paths = unknown.map((file) => file.key.slice("path:".length));
    void (async () => {
      const owners = new Map<string, string>();
      for (
        let start = 0;
        start < paths.length;
        start += DEVICE_FILE_COPY_LIMITS.maxLocatePaths
      ) {
        const chunk = paths.slice(start, start + DEVICE_FILE_COPY_LIMITS.maxLocatePaths);
        try {
          const { files: locations } = await getBackendClient().call(
            "drive.locateDeviceFiles",
            { paths: chunk },
          );
          for (const path of chunk) {
            const location = pickDeviceFileLocation(locations, path);
            if (location) owners.set(`path:${path}`, location.deviceId);
          }
        } catch {
          return;
        }
      }
      if (run !== generation.current || owners.size === 0) return;
      setFiles((current) =>
        current.map((file) => {
          const deviceId = owners.get(file.key);
          return deviceId && file.source.kind === "computer" && !file.source.deviceId
            ? { ...file, source: { kind: "computer", deviceId } }
            : file;
        }),
      );
    })();
  }, [files]);

  return {
    files,
    loading,
    available,
    loadingMore,
    hasMore: cursor.phase !== "done",
    loadMore,
    deviceNames,
  };
}
