import { useEffect, useMemo, useRef, useState } from "react";
import { stella } from "@stella/apps-sdk";
import {
  createAppOperations,
  createStateApi,
  operationFns,
  type AppState,
} from "./operations";

const initialState: AppState = {
  habits: [
    { name: "Morning walk", detail: "Twenty minutes outside.", progress: 40 },
    { name: "Deep work", detail: "One focused block.", progress: 0 },
  ],
  focus: "Start small and keep going.",
};

// The example UI and the Stella agent share one implementation: every button
// below calls the same deterministic functions the agent invokes through
// registered operations. Durable state lives in stella.storage; operations
// mutate live state and render immediately.
export default function App() {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const api = useMemo(
    () =>
      createStateApi(
        () => stateRef.current,
        (next) => {
          setState(next);
          void stella?.storage.set("app-state", next);
        },
      ),
    [],
  );
  const fns = useMemo(() => operationFns(api), [api]);

  useEffect(() => {
    let disposed = false;
    void stella?.storage.get<AppState>("app-state").then((saved) => {
      if (!disposed && saved?.habits?.length) setState(saved);
    });
    void stella?.operations.register(createAppOperations(api));
    return () => {
      disposed = true;
    };
  }, [api]);

  return (
    <main>
      <h1>Stella cloud app</h1>
      <p>{state.focus}</p>
      {state.habits.map((habit) => (
        <section key={habit.name}>
          <h2>
            {habit.name} · {habit.progress}%
          </h2>
          <p>{habit.detail}</p>
          <button
            type="button"
            onClick={() =>
              fns.setHabitProgress({
                habit: habit.name,
                progress: habit.progress + 10,
              })
            }
          >
            +10%
          </button>
          <button
            type="button"
            onClick={() => fns.completeHabit({ habit: habit.name })}
          >
            Done
          </button>
        </section>
      ))}
      <button type="button" onClick={() => fns.resetDay()}>
        Reset day
      </button>
    </main>
  );
}
