/** FIFO Web Locks model, including shared and nonblocking requests. */
export function createWebLocksMock() {
  const states = new Map();
  return {
    request(name, options, callback) {
      if (typeof options === "function") { callback = options; options = {}; }
      const mode = options.mode || "exclusive";
      let state = states.get(name);
      if (!state) { state = { active: 0, mode: null, queue: [] }; states.set(name, state); }
      const available = () => !state.active || (state.mode === "shared" && mode === "shared" && !state.queue.length);
      if (options.ifAvailable && !available()) return Promise.resolve().then(() => callback(null));
      return new Promise((resolve, reject) => {
        const start = () => {
          state.active++; state.mode = mode;
          const release = () => {
            state.active--;
            if (!state.active) {
              state.mode = null;
              const next = state.queue.shift(); next?.();
            }
          };
          Promise.resolve().then(() => callback({ name, mode })).then(
            (value) => { release(); resolve(value); },
            (error) => { release(); reject(error); }
          );
        };
        if (available()) start(); else state.queue.push(start);
      });
    },
  };
}
