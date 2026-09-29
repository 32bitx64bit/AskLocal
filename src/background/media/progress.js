/**
 * Progress helpers for parallel media chunk pools.
 *
 * Why this exists: when several windows run at once, per-chunk heartbeats used to
 * say "Still analyzing video chunk 1 of 5..." after later windows had already
 * finished — so the status line looked like the chunk count was going backwards.
 * These reporters always show completed/total (monotonic) plus active count.
 */

/**
 * @param {(message: string) => unknown} reportProgress
 * @param {{ kind: string, total?: number }} options
 */
export function createMediaChunkPoolProgress(reportProgress, { kind, total = 0 }) {
  const state = {
    completed: 0,
    active: 0,
    total: Math.max(0, Math.floor(Number(total) || 0)),
    lastRendered: ""
  };

  const render = (suffix = "") => {
    const totalLabel = state.total > 0 ? String(state.total) : "?";
    const message = [
      `Analyzing ${kind} windows ${state.completed}/${totalLabel}`,
      state.active > 0 ? `(${state.active} active)` : "(finishing)",
      suffix
    ].filter(Boolean).join(" ");
    if (message === state.lastRendered && !suffix) return;
    state.lastRendered = message.replace(/\s—\s\d+s$/, "");
    void reportProgress?.(suffix ? `${message}...` : `${message}...`);
  };

  return {
    start() {
      state.active += 1;
      render();
    },
    finish() {
      state.active = Math.max(0, state.active - 1);
      state.completed = state.total > 0
        ? Math.min(state.total, state.completed + 1)
        : state.completed + 1;
      render();
    },
    setTotal(nextTotal) {
      const value = Math.max(0, Math.floor(Number(nextTotal) || 0));
      if (value > state.total) {
        state.total = value;
        render();
      }
    },
    /** Heartbeat callback for callVideo/AudioChunkAnalysis — never mentions a window index. */
    bindHeartbeat() {
      const startedAt = Date.now();
      return () => {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        render(`— ${seconds}s`);
      };
    },
    note(message) {
      if (message) void reportProgress?.(message);
    }
  };
}

/**
 * Shared progress when video + audio map phases run together (including while capture continues).
 * Always renders both counters so the UI never flips between two separate "N/M" lines.
 *
 * @param {(message: string) => unknown} reportProgress
 * @param {{ videoTotal?: number, audioTotal?: number }} options
 */
export function createDualAvMapProgress(reportProgress, { videoTotal = 0, audioTotal = 0 } = {}) {
  const state = {
    videoDone: 0,
    audioDone: 0,
    videoActive: 0,
    audioActive: 0,
    videoTotal: Math.max(0, Math.floor(Number(videoTotal) || 0)),
    audioTotal: Math.max(0, Math.floor(Number(audioTotal) || 0)),
    capturing: true
  };

  const render = (suffix = "") => {
    const videoTotalLabel = state.videoTotal > 0 ? String(state.videoTotal) : "?";
    const audioTotalLabel = state.audioTotal > 0 ? String(state.audioTotal) : "?";
    const message = [
      state.capturing ? "Capturing + mapping media —" : "Mapping media —",
      `video ${state.videoDone}/${videoTotalLabel}`,
      state.videoActive > 0 ? `(${state.videoActive} active)` : "",
      `· audio ${state.audioDone}/${audioTotalLabel}`,
      state.audioActive > 0 ? `(${state.audioActive} active)` : "",
      suffix
    ].filter(Boolean).join(" ");
    void reportProgress?.(`${message}...`);
  };

  const makeSide = (side) => ({
    start() {
      state[`${side}Active`] += 1;
      render();
    },
    finish() {
      state[`${side}Active`] = Math.max(0, state[`${side}Active`] - 1);
      const totalKey = `${side}Total`;
      const doneKey = `${side}Done`;
      state[doneKey] = state[totalKey] > 0
        ? Math.min(state[totalKey], state[doneKey] + 1)
        : state[doneKey] + 1;
      render();
    },
    setTotal(nextTotal) {
      const value = Math.max(0, Math.floor(Number(nextTotal) || 0));
      const totalKey = `${side}Total`;
      if (value > state[totalKey]) {
        state[totalKey] = value;
        render();
      }
    },
    bindHeartbeat() {
      const startedAt = Date.now();
      return () => {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        render(`— ${seconds}s`);
      };
    },
    note(message) {
      if (message) void reportProgress?.(message);
    }
  });

  return {
    video: makeSide("video"),
    audio: makeSide("audio"),
    setCapturing(value) {
      state.capturing = Boolean(value);
      render();
    },
    render
  };
}
