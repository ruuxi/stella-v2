// Hermetic test environment.
//
// The renderer/runtime suite must resolve source-tree assets (connector
// catalogs, bundled rg, agent markdown) from THIS repo, never from an
// installed Stella app. When the suite runs from inside a running Stella
// process (dev, or any shell that inherited the app's env), the host exports
// `STELLA_APP_DIR` / `STELLA_APP_RESOURCES_PATH` pointing at
// `…/Stella.app/Contents/Resources`. Runtime path resolution
// (`runtime-paths.ts`, `ripgrep.ts`, the connector catalog loaders) prefers
// those over the repo, so the packaged layout — which lays assets out
// differently and has no `packages/runtime/**` tree — makes catalog and
// ripgrep lookups throw ENOENT or return the app's binaries.
//
// Tests that care about these paths already set their own env explicitly, so
// the only effect of the leaked host values is spurious, environment-dependent
// failures. Strip every `STELLA_*` var up front so the suite behaves the same
// whether or not it was launched from inside the app (i.e. matches CI).
for (const key of Object.keys(process.env)) {
  if (key.startsWith("STELLA_")) {
    delete process.env[key];
  }
}

// Newer Node releases expose a global localStorage getter that resolves to
// undefined unless --localstorage-file is configured. jsdom can inherit that
// descriptor instead of installing its own Storage object, so browser tests
// need a deterministic per-worker fallback.
if (typeof window !== "undefined") {
  let hasUsableStorage = false;
  try {
    hasUsableStorage = typeof window.localStorage?.getItem === "function";
  } catch {
    hasUsableStorage = false;
  }

  if (!hasUsableStorage) {
    const entries = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return entries.size;
      },
      clear: () => entries.clear(),
      getItem: (key) => entries.get(String(key)) ?? null,
      key: (index) => [...entries.keys()][index] ?? null,
      removeItem: (key) => {
        entries.delete(String(key));
      },
      setItem: (key, value) => {
        entries.set(String(key), String(value));
      },
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
}
