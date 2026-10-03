/**
 * How much work runs at once. "local" suits one GPU serving one request at a time;
 * "api" suits hosted providers that answer many requests in parallel; "custom" uses the
 * numbers from settings. Lane names match orchestrator/tasks.js.
 */

export const PERFORMANCE_PROFILES = {
  local: {
    lanes: { x: 2, capture: 1, vision: 1, audio: 1, text: 1, web: 2 },
    videoChunkConcurrency: 1,
    autoMediaMaxVideos: 2,
    autoMediaMaxImages: 4
  },
  api: {
    lanes: { x: 4, capture: 3, vision: 12, audio: 6, text: 4, web: 4 },
    videoChunkConcurrency: 6,
    autoMediaMaxVideos: 6,
    autoMediaMaxImages: 16
  }
};

export function normalizePerformanceProfile(value) {
  const name = String(value || "").trim().toLowerCase();
  return name === "api" || name === "custom" ? name : "local";
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Effective limits for the current settings.
 * @returns {{ profile: string, lanes: object, videoChunkConcurrency: number, autoMediaMaxVideos: number, autoMediaMaxImages: number }}
 */
export function resolvePerformance(settings = {}) {
  const profile = normalizePerformanceProfile(settings.performanceProfile);
  if (profile !== "custom") {
    const preset = PERFORMANCE_PROFILES[profile];
    return { profile, ...preset, lanes: { ...preset.lanes } };
  }
  const base = PERFORMANCE_PROFILES.local;
  const modelCalls = clampInt(settings.parallelModelCalls, 1, 32, 1);
  const captures = clampInt(settings.parallelVideoCaptures, 1, 6, 1);
  return {
    profile,
    lanes: {
      ...base.lanes,
      capture: captures,
      vision: modelCalls,
      audio: modelCalls,
      text: Math.max(1, Math.ceil(modelCalls / 2)),
      x: Math.max(2, Math.min(4, modelCalls)),
      web: Math.max(2, Math.min(4, modelCalls))
    },
    videoChunkConcurrency: clampInt(settings.videoChunkConcurrency, 1, 8, 1),
    autoMediaMaxVideos: clampInt(settings.autoMediaMaxVideos, 0, 12, base.autoMediaMaxVideos),
    autoMediaMaxImages: clampInt(settings.autoMediaMaxImages, 0, 32, base.autoMediaMaxImages)
  };
}
