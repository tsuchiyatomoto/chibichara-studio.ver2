import type { Dispatch, SetStateAction } from "react";

type Setters<State> = {
  [Key in keyof State]: Dispatch<SetStateAction<State[Key]>>;
};

// One session per browser document. React reads only the initial snapshot during
// server rendering; client-side navigation keeps the current session alive.
export function createAvatarSession<State extends object>(initialState: State) {
  let state = initialState;
  const listeners = new Set<() => void>();
  const setters = {} as Setters<State>;

  for (const key of Object.keys(initialState) as Array<keyof State>) {
    setters[key] = (action) => {
      const previous = state[key];
      const next = typeof action === "function"
        ? (action as (value: typeof previous) => typeof previous)(previous)
        : action;
      if (Object.is(previous, next)) return;
      state = { ...state, [key]: next };
      for (const listener of listeners) listener();
    };
  }

  return {
    setters,
    getSnapshot: () => state,
    getServerSnapshot: () => initialState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
