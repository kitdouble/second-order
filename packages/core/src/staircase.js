// Adaptive staircase shared by the participant runtime and the simulator, so
// a simulated participant goes through exactly the procedure a real one does.
//
// Rules: "2down1up" (converges on ~70.7% correct), "3down1up" (~79.4%).
// Step size shrinks after reversals: step[min(reversals, step.length - 1)].

const DOWN = { "2down1up": 2, "3down1up": 3 };

export function createStaircase(cfg, from = null) {
  const down = DOWN[cfg.rule ?? "2down1up"];
  const steps = cfg.step ?? [4, 2, 1];
  const min = cfg.min_diff ?? 1;
  const max = cfg.max_diff ?? 100;
  const state = from
    ? { ...from }
    : { value: cfg.start_diff ?? 20, streak: 0, lastDir: 0, reversals: 0, history: [] };

  return {
    get value() {
      return state.value;
    },
    get reversals() {
      return state.reversals;
    },
    /** Updates after a trial. Returns the new value. */
    update(correct) {
      let dir = 0;
      if (correct) {
        state.streak += 1;
        if (state.streak >= down) {
          dir = -1; // harder
          state.streak = 0;
        }
      } else {
        dir = +1; // easier
        state.streak = 0;
      }
      if (dir !== 0) {
        if (state.lastDir !== 0 && dir !== state.lastDir) state.reversals += 1;
        state.lastDir = dir;
        const step = steps[Math.min(state.reversals, steps.length - 1)];
        state.value = Math.min(max, Math.max(min, state.value + dir * step));
      }
      state.history.push(state.value);
      return state.value;
    },
    snapshot() {
      return { ...state, history: state.history.slice() };
    },
  };
}
