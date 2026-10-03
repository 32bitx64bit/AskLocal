/**
 * Shared background work for the ask pipeline.
 *
 * Two pieces:
 *
 * - Tasks: deduplicated units of work identified by a key ("thread:123",
 *   "media:x-video:456:auto:…"). Asking for a key that is already running joins it
 *   instead of starting a second copy, so a prefetch started when the panel opened, the
 *   ask that follows, and a tool call for the same video all share one run. Each caller
 *   waits with its own AbortSignal; the task itself is aborted only when every caller
 *   has gone and the task was not marked to keep running in the background.
 *
 * - Lanes: counting semaphores for the leaf I/O (X API calls, video captures, vision /
 *   audio / text model calls, page reads). Limits come from the performance profile:
 *   one at a time for a local GPU, many at once for a hosted API. Only leaf calls take a
 *   lane slot; tasks never hold one while waiting on other work, so nesting cannot
 *   deadlock.
 *
 * Pure apart from an optional keepalive hook, so it runs under `node --test`.
 */

const DEFAULT_LIMITS = { x: 2, capture: 1, vision: 1, audio: 1, text: 1, web: 2 };

const lanes = new Map();
const tasks = new Map();
let keepAlive = null;
let keepAliveTimer = null;

function abortError(reason) {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("Aborted.");
  error.name = "AbortError";
  return error;
}

function laneState(name) {
  let lane = lanes.get(name);
  if (!lane) {
    lane = { limit: DEFAULT_LIMITS[name] ?? 1, active: 0, queue: [] };
    lanes.set(name, lane);
  }
  return lane;
}

function pumpLane(lane) {
  while (lane.active < lane.limit && lane.queue.length) {
    const next = lane.queue.shift();
    if (next.cancelled) continue;
    lane.active += 1;
    next.grant();
  }
}

/** Set lane limits ({ vision: 6, … }). Raising a limit starts queued work right away. */
export function configureLanes(limits = {}) {
  for (const [name, value] of Object.entries(limits)) {
    const limit = Math.max(1, Math.floor(Number(value) || 1));
    const lane = laneState(name);
    lane.limit = limit;
    pumpLane(lane);
  }
}

export function laneLimit(name) {
  return laneState(name).limit;
}

/**
 * Run `fn` once a slot in `lane` is free. The slot is released when `fn` settles.
 * Waiting for a slot stops early (and rejects) if `signal` aborts.
 */
export async function withLane(name, fn, signal = null) {
  const lane = laneState(name);
  if (signal?.aborted) throw abortError(signal.reason);
  if (lane.active < lane.limit) {
    lane.active += 1;
  } else {
    await new Promise((resolve, reject) => {
      const ticket = { cancelled: false, grant: () => { signal?.removeEventListener?.("abort", onAbort); resolve(); } };
      const onAbort = () => {
        ticket.cancelled = true;
        reject(abortError(signal.reason));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      lane.queue.push(ticket);
    });
  }
  try {
    return await fn();
  } finally {
    lane.active = Math.max(0, lane.active - 1);
    pumpLane(lane);
  }
}

/**
 * A function the platform calls periodically while any task is running, so an MV3
 * service worker is not idled out in the middle of background work nobody is
 * listening to (no open Port).
 */
export function setTaskKeepAlive(fn, intervalMs = 20_000) {
  keepAlive = typeof fn === "function" ? { fn, intervalMs } : null;
  syncKeepAlive();
}

function syncKeepAlive() {
  const wanted = Boolean(keepAlive && tasks.size);
  if (wanted && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      try {
        keepAlive?.fn();
      } catch {
        // Best-effort.
      }
    }, keepAlive.intervalMs);
  } else if (!wanted && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/**
 * Run (or join) the task `key`.
 *
 * @param {string} key
 * @param {object} options
 * @param {(ctx: { signal: AbortSignal, progress: (message: string) => void }) => Promise<any>} options.run
 * @param {AbortSignal} [options.signal]        this caller's signal; aborting it only detaches this caller
 * @param {boolean} [options.background]        keep running after every caller detached (results still get cached)
 * @param {(message: string) => void} [options.onProgress]  this caller's progress sink; all joined callers see the task's progress
 */
export function runTask(key, { run, signal = null, background = false, onProgress = null } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));

  let task = tasks.get(key);
  if (!task) {
    const controller = new AbortController();
    task = {
      key,
      controller,
      waiters: new Set(),
      background: Boolean(background),
      lastProgress: "",
      promise: null
    };
    const progress = (message) => {
      task.lastProgress = String(message || "");
      for (const waiter of task.waiters) {
        try {
          waiter.onProgress?.(task.lastProgress);
        } catch {
          // A detached panel's sink can throw; others still get updates.
        }
      }
    };
    tasks.set(key, task);
    syncKeepAlive();
    task.promise = Promise.resolve()
      .then(() => run({ signal: controller.signal, progress }))
      .finally(() => {
        if (tasks.get(key) === task) tasks.delete(key);
        syncKeepAlive();
      });
    // Nobody may be waiting by the time a background task fails.
    task.promise.catch(() => {});
  } else if (background) {
    task.background = true;
  }

  const waiter = { onProgress };
  task.waiters.add(waiter);
  if (task.lastProgress && onProgress) {
    try {
      onProgress(task.lastProgress);
    } catch {
      // Ignore.
    }
  }

  const detach = () => {
    task.waiters.delete(waiter);
    if (task.waiters.size || task.background) return;
    // Unlist it first: a caller arriving after this must start fresh, not join a run
    // that is about to reject with AbortError.
    if (tasks.get(key) === task) tasks.delete(key);
    syncKeepAlive();
    task.controller.abort();
  };

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      detach();
      reject(abortError(signal.reason));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    task.promise.then(
      (value) => {
        signal?.removeEventListener?.("abort", onAbort);
        task.waiters.delete(waiter);
        resolve(value);
      },
      (error) => {
        signal?.removeEventListener?.("abort", onAbort);
        task.waiters.delete(waiter);
        reject(error);
      }
    );
  });
}

/** True while a task with this key is running. */
export function isTaskRunning(key) {
  return tasks.has(key);
}

/** Snapshot for diagnostics: running task keys and lane usage. */
export function describeTasks() {
  return {
    tasks: [...tasks.values()].map((task) => ({ key: task.key, waiters: task.waiters.size, background: task.background, progress: task.lastProgress })),
    lanes: Object.fromEntries([...lanes.entries()].map(([name, lane]) => [name, { limit: lane.limit, active: lane.active, queued: lane.queue.length }]))
  };
}

/** Test hook: forget all state. */
export function resetTasksForTests() {
  for (const task of tasks.values()) task.controller.abort();
  tasks.clear();
  lanes.clear();
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  keepAlive = null;
}
