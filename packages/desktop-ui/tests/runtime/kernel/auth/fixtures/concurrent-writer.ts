// Child-process fixture for the two-process store race test. Run under bun:
//   bun concurrent-writer.ts <dataDir> <key> <iterations>
// It writes `<key>` = 0..N-1 into the shared auth session store. With a correct
// inter-process lock, a concurrent sibling writing a different key must never
// lose either writer's final value or drop the other's key from the map.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [dataDir, key, iterationsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);

const storePath = path.resolve(
  import.meta.dirname,
  "../../../../../../runtime/kernel/auth/store.ts",
);
const mod = (await import(pathToFileURL(storePath).href)) as {
  createAuthSessionStore: (options: { stellaDataDir: string }) => {
    setItem: (key: string, value: string | null) => void;
  };
};

const store = mod.createAuthSessionStore({ stellaDataDir: dataDir });
for (let i = 0; i < iterations; i++) {
  store.setItem(key, String(i));
}
