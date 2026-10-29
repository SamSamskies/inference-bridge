/** Minimal exclusive Web Locks model shared by the mocked browser contexts. */
export function createWebLocksMock() {
  const tails = new Map();
  return {
    request(name, callback) {
      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.then(() => callback({ name, mode: "exclusive" }));
      // A rejected operation releases its lock and must not poison the queue.
      const tail = result.then(() => {}, () => {});
      tails.set(name, tail);
      tail.then(() => {
        if (tails.get(name) === tail) tails.delete(name);
      });
      return result;
    },
  };
}
