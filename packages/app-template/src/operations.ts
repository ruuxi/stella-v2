/**
 * Stella app operations — the conventional operations module.
 *
 * UI controls and the Stella agent call the same deterministic functions.
 * Durable state remains in stella.storage while operations update live state.
 */
import type { StellaOperationDef } from "@stella/apps-sdk";

export type Habit = { name: string; detail: string; progress: number };
export type AppState = { habits: Habit[]; focus: string };

export type StateApi = {
  get: () => AppState;
  set: (next: AppState) => AppState;
};

export const createStateApi = (
  get: () => AppState,
  apply: (next: AppState) => void,
): StateApi => ({
  get,
  set: (next) => {
    apply(next);
    return next;
  },
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const requireHabit = (state: AppState, name: string): Habit => {
  const normalized = name.trim().toLowerCase();
  const habit = state.habits.find(
    (candidate) => candidate.name.toLowerCase() === normalized,
  );
  if (!habit) {
    throw new Error(
      `No habit named "${name}". Habits: ${state.habits
        .map((candidate) => candidate.name)
        .join(", ")}.`,
    );
  }
  return habit;
};

export const operationFns = (api: StateApi) => {
  const setHabitProgress = (args: { habit: string; progress: number }) => {
    const state = api.get();
    const habit = requireHabit(state, args.habit);
    if (!Number.isFinite(args.progress)) {
      throw new Error("progress must be a number between 0 and 100.");
    }
    const progress = clamp(Math.round(args.progress), 0, 100);
    api.set({
      ...state,
      habits: state.habits.map((candidate) =>
        candidate === habit ? { ...candidate, progress } : candidate,
      ),
    });
    return { habit: habit.name, progress };
  };
  const completeHabit = (args: { habit: string }) =>
    setHabitProgress({ habit: args.habit, progress: 100 });
  const setFocus = (args: { focus: string }) => {
    const focus = args.focus.trim().slice(0, 120);
    if (!focus) throw new Error("focus must not be empty.");
    api.set({ ...api.get(), focus });
    return { focus };
  };
  const resetDay = () => {
    const state = api.get();
    api.set({
      ...state,
      habits: state.habits.map((habit) => ({ ...habit, progress: 0 })),
    });
    return { habits: state.habits.length, progress: 0 };
  };
  return { setHabitProgress, completeHabit, setFocus, resetDay };
};

export const createAppOperations = (api: StateApi): StellaOperationDef[] => {
  const fns = operationFns(api);
  return [
    {
      name: "set-habit-progress",
      description: "Set a habit's completion percent for today (0–100).",
      args: [
        {
          name: "habit",
          type: "string",
          required: true,
          description: "Habit name",
        },
        {
          name: "progress",
          type: "number",
          required: true,
          description: "0–100",
        },
      ],
      handler: (args) =>
        fns.setHabitProgress(args as { habit: string; progress: number }),
    },
    {
      name: "complete-habit",
      description: "Mark a habit as done for today.",
      args: [
        {
          name: "habit",
          type: "string",
          required: true,
          description: "Habit name",
        },
      ],
      handler: (args) => fns.completeHabit(args as { habit: string }),
    },
    {
      name: "set-focus",
      description: "Change the current focus message shown in the focus panel.",
      args: [
        {
          name: "focus",
          type: "string",
          required: true,
          description: "New focus text",
        },
      ],
      handler: (args) => fns.setFocus(args as { focus: string }),
    },
    {
      name: "reset-day",
      description: "Reset every habit's progress to zero for a fresh day.",
      args: [],
      handler: () => fns.resetDay(),
    },
  ];
};
