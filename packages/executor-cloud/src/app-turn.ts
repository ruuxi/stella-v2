import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { createToolHost } from "@stella/runtime/kernel/tools/host.js";

type Habit = { name: string; detail: string; progress: number };
type AppSpec = {
  title: string;
  eyebrow: string;
  headline: string;
  subhead: string;
  accent: string;
  accentSoft: string;
  habits: Habit[];
  focus: string;
};

type TurnInput = { prompt: string; spec: AppSpec };

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const readNumber = async (file: string): Promise<number> => {
  const raw = await readFile(file, "utf8").catch(() => "0");
  return Number(raw.trim()) || 0;
};

const readCpuUsec = async (): Promise<number> => {
  const raw = await readFile("/sys/fs/cgroup/cpu.stat", "utf8").catch(() => "");
  return Number(/^usage_usec\s+(\d+)$/m.exec(raw)?.[1] ?? 0);
};

const assertToolCommandSucceeded = (
  value: Record<string, unknown>,
  label: string,
): void => {
  if (value.error) throw new Error(`${label}: ${String(value.error)}`);
  const payload = value.result as Record<string, unknown> | undefined;
  if (!payload || payload.running === true || payload.exit_code !== 0) {
    throw new Error(
      `${label}: ${JSON.stringify(payload ?? value).slice(0, 4_000)}`,
    );
  }
};

// Generated apps follow the operations convention: UI controls and the Stella
// agent call the same deterministic functions from src/operations.ts, durable
// state lives in stella.storage, and operations mutate live state.
const appSource = (spec: AppSpec): string => `import React, { useEffect, useMemo, useRef, useState } from "react";
import { stella } from "@stella/apps-sdk";
import { createAppOperations, createStateApi, operationFns } from "./operations";

const initialState = { habits: ${JSON.stringify(spec.habits)}, focus: ${JSON.stringify(spec.focus)} };

export default function App() {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const api = useMemo(() => createStateApi(
    () => stateRef.current,
    (next) => { setState(next); void stella?.storage.set("app-state", next); },
  ), []);
  const fns = useMemo(() => operationFns(api), [api]);
  useEffect(() => {
    let disposed = false;
    void stella?.storage.get("app-state").then((saved) => {
      const restored = saved as typeof initialState | null;
      if (!disposed && restored && Array.isArray(restored.habits) && restored.habits.length) setState(restored);
    });
    void stella?.operations.register(createAppOperations(api));
    return () => { disposed = true; };
  }, [api]);
  const habits = state.habits;
  const completed = habits.filter((habit) => habit.progress >= 100).length;
  const average = Math.round(habits.reduce((sum, habit) => sum + habit.progress, 0) / habits.length);
  return (
    <main className="shell">
      <nav><strong>${spec.title}</strong><span>Today · {new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" })}</span></nav>
      <section className="hero">
        <div><p className="eyebrow">${spec.eyebrow}</p><h1>${spec.headline}</h1><p className="subhead">${spec.subhead}</p></div>
        <div className="ring" style={{"--progress": average} as React.CSSProperties}><span>{average}%</span><small>daily rhythm</small></div>
      </section>
      <section className="grid">
        {habits.map((habit, index) => <article className="habit" key={habit.name}>
          <header><span className="number">0{index + 1}</span><span className={habit.progress >= 100 ? "done" : "open"}>{habit.progress >= 100 ? "complete" : "in motion"}</span></header>
          <h2>{habit.name}</h2><p>{habit.detail}</p>
          <div className="track"><i style={{width: \`\${habit.progress}%\`}} /></div>
          <div className="habit-actions">
            <small>{habit.progress}%</small>
            <button type="button" onClick={() => fns.setHabitProgress({ habit: habit.name, progress: habit.progress + 10 })}>+10%</button>
            <button type="button" onClick={() => fns.completeHabit({ habit: habit.name })}>Done</button>
          </div>
        </article>)}
      </section>
      <aside><div><p className="eyebrow">Focus for now</p><h2>{state.focus}</h2></div><button type="button" onClick={() => fns.resetDay()}>Reset the day</button></aside>
      <footer>{completed} of {habits.length} rituals complete <span>Small returns become a life.</span></footer>
    </main>
  );
}
`;

const styleSource = (spec: AppSpec): string => `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#182019;background:#f4f1e8;--accent:${spec.accent};--soft:${spec.accentSoft}}*{box-sizing:border-box}body{margin:0;min-width:320px;min-height:100vh;background:radial-gradient(circle at 85% 0%,var(--soft),transparent 34%),#f4f1e8}.shell{max-width:1180px;margin:auto;padding:28px 34px 48px}nav{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1d2b2022;padding-bottom:20px}nav strong{font-family:Georgia,serif;font-size:24px}nav span,small{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#58645a}.hero{display:grid;grid-template-columns:1fr 220px;gap:60px;align-items:center;padding:70px 0 52px}.eyebrow{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);font-weight:750}.hero h1{font:clamp(48px,7vw,84px)/.97 Georgia,serif;max-width:760px;margin:14px 0 22px;letter-spacing:-.045em}.subhead{font-size:18px;line-height:1.7;color:#526057;max-width:600px}.ring{--p:calc(var(--progress)*1%);width:190px;height:190px;border-radius:50%;display:grid;place-content:center;text-align:center;background:radial-gradient(closest-side,#f4f1e8 78%,transparent 79% 99%),conic-gradient(var(--accent) var(--p),#d9ddd5 0)}.ring span{font:42px Georgia,serif}.ring small{margin-top:5px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.habit{background:#fffdf7;border:1px solid #1c2d2016;border-radius:18px;padding:22px;box-shadow:0 14px 35px #2231260a}.habit header{display:flex;justify-content:space-between}.number{font:22px Georgia,serif;color:var(--accent)}.done,.open{font-size:10px;text-transform:uppercase;letter-spacing:.12em}.done{color:var(--accent)}.open{color:#879087}.habit h2{font:26px Georgia,serif;margin:38px 0 8px}.habit p{min-height:50px;color:#667067;line-height:1.5}.track{height:5px;border-radius:9px;background:#e3e5df;margin:30px 0 10px;overflow:hidden}.track i{display:block;height:100%;background:var(--accent);border-radius:inherit}.habit-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}.habit-actions button{border:1px solid #1c2d2022;border-radius:999px;background:#f6f4ea;padding:6px 12px;font-size:12px;font-weight:700;color:#1d2b20;cursor:pointer}.habit-actions button:hover{background:var(--soft)}aside{margin-top:18px;background:#1d2b20;color:#f9f6eb;border-radius:22px;padding:30px 34px;display:flex;justify-content:space-between;align-items:center}aside .eyebrow{color:#aacaac}aside h2{font:30px Georgia,serif;margin:8px 0}button{border:0;border-radius:999px;background:#f6f1df;padding:15px 22px;font-weight:700;color:#1d2b20}footer{display:flex;justify-content:space-between;padding:28px 4px 0;color:#667067;font-size:13px}@media(max-width:850px){.hero{grid-template-columns:1fr}.ring{display:none}.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:540px){.shell{padding:20px}.hero{padding:48px 0 34px}.grid{grid-template-columns:1fr}aside{align-items:flex-start;gap:24px;flex-direction:column}footer span{display:none}}`;

export type AppTurnResult = {
  ok: true;
  runtimeTools: string[];
  metrics: {
    dependencyHydrationMs: number;
    productionBuildMs: number;
    activeCpuSeconds: number;
    peakMemoryBytes: number;
    workspaceDiskBytes: number;
  };
};

export const runAppTurn = (
  workspaceRoot = "/workspace/app",
): Effect.Effect<AppTurnResult, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise({
        try: async () =>
          JSON.parse(
            await readFile("/workspace/turn-input.json", "utf8"),
          ) as TurnInput,
        catch: asError,
      });
      const cpuBefore = yield* Effect.promise(readCpuUsec);
      const started = performance.now();
      const toolHost = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createToolHost({
            stellaAppDir: workspaceRoot,
            stellaDataDir: path.join(workspaceRoot, ".stella"),
          }),
        ),
        (host) =>
          Effect.tryPromise({ try: () => host.shutdown(), catch: asError }).pipe(
            Effect.orDie,
          ),
      );
      const context = {
        conversationId: "cloud-app-turn",
        deviceId: "cloud",
        requestId: crypto.randomUUID(),
        workingDirectory: workspaceRoot,
        toolWorkspaceRoot: workspaceRoot,
        storageMode: "cloud" as const,
      };
      const hydrationStarted = performance.now();
      const hydrate = yield* Effect.tryPromise({
        try: () =>
          toolHost.executeTool(
            "exec_command",
            {
              cmd: "mkdir -p /workspace/app && cp -R /opt/stella/packages/app-template/. /workspace/app/ && rm -rf /workspace/app/node_modules && ln -s /opt/stella/node_modules /workspace/app/node_modules",
              workdir: "/workspace",
              login: false,
              yield_time_ms: 30_000,
            },
            context,
          ),
        catch: asError,
      });
      yield* Effect.try({ try: () => assertToolCommandSucceeded(hydrate, "Dependency hydration failed"), catch: asError });
      const dependencyHydrationMs = performance.now() - hydrationStarted;
      for (const [file, content] of [
        ["src/App.tsx", appSource(input.spec)],
        ["src/styles.css", styleSource(input.spec)],
      ] as const) {
        const result = yield* Effect.tryPromise({
          try: () =>
            toolHost.executeTool(
              "Write",
              { file_path: path.join(workspaceRoot, file), content },
              context,
            ),
          catch: asError,
        });
        if ("error" in result && result.error) {
          return yield* Effect.fail(new Error(String(result.error)));
        }
      }
      const buildStarted = performance.now();
      const build = yield* Effect.tryPromise({
        try: () =>
          toolHost.executeTool(
            "exec_command",
            {
              cmd: "/usr/local/bin/vite build >/tmp/stella-vite-build.log 2>&1; status=$?; cat /tmp/stella-vite-build.log; exit $status",
              workdir: workspaceRoot,
              login: false,
              yield_time_ms: 30_000,
              max_output_tokens: 4_000,
            },
            context,
          ),
        catch: asError,
      });
      yield* Effect.try({ try: () => assertToolCommandSucceeded(build, "Production build failed"), catch: asError });
      const productionBuildMs = performance.now() - buildStarted;
      const disk = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["du", "-sb", "/workspace"], { stdout: "pipe" });
          const output = await new Response(proc.stdout).text();
          await proc.exited;
          return Number(output.trim().split(/\s+/)[0] ?? 0);
        },
        catch: asError,
      });
      const cpuAfter = yield* Effect.promise(readCpuUsec);
      const peakMemoryBytes = yield* Effect.promise(async () => {
        const peak = await readNumber("/sys/fs/cgroup/memory.peak");
        const current = await readNumber("/sys/fs/cgroup/memory.current");
        return Math.max(peak, current, process.memoryUsage.rss());
      });
      return {
        ok: true as const,
        runtimeTools: ["exec_command", "Write"],
        metrics: {
          dependencyHydrationMs: Math.round(dependencyHydrationMs),
          productionBuildMs: Math.round(productionBuildMs),
          activeCpuSeconds: Math.max(0, (cpuAfter - cpuBefore) / 1_000_000),
          peakMemoryBytes,
          workspaceDiskBytes: disk,
        },
      };
    }),
  );
