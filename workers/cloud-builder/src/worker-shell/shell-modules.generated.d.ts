/**
 * The worker shell's Dynamic Worker modules, generated from
 * `src/worker-shell/entry.ts` and the pinned just-bash by
 * `scripts/build-worker-shell.mjs`. The `.js` file is not checked in.
 */
declare const bundle: Readonly<{
  /** Content hash of `modules`; names the Worker Loader isolate. */
  id: string;
  modules: Readonly<Record<string, Readonly<{ js: string }>>>;
}>;
export default bundle;
