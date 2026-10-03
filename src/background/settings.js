import { api } from "./api.js";
import {
  DEFAULT_MODEL_CONTEXT_TOKENS,
  DEFAULT_MULTI_LINKS,
  DEFAULT_TEMPERATURE,
  DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  DEFAULT_VIDEO_CHUNK_SECONDS,
  MAX_MODEL_CONTEXT_TOKENS,
  MAX_MULTI_LINKS,
  MAX_VIDEO_CHUNK_CONCURRENCY,
  MAX_VIDEO_CHUNK_SECONDS,
  MIN_MODEL_CONTEXT_TOKENS,
  MIN_MULTI_LINKS,
  MIN_VIDEO_CHUNK_CONCURRENCY,
  MIN_VIDEO_CHUNK_SECONDS,
  MIN_VIDEO_FRAME_INTERVAL_SECONDS,
  SETTINGS_STORE_KEY,
  VIDEO_SAMPLING_DEFAULTS_VERSION
} from "./constants.js";
import {
  clampNumber
} from "../lib/utils.js";
import {
  resolveOpenAICompatibleEndpoint
} from "./providers/openai-compatible.js";
import {
  SEARCH_ENGINE_REGISTRY
} from "./search/web-search.js";
import {
  normalizePerformanceProfile
} from "./orchestrator/profile.js";

const DEFAULT_MAIN_MODEL_ID = "default-main";

export function createModelId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Fall through.
  }
  return `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultMainModel(overrides = {}) {
  return {
    id: DEFAULT_MAIN_MODEL_ID,
    name: "Default",
    provider: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: "llama3.2",
    apiKey: "",
    usableAsMainText: true,
    ...overrides
  };
}

export const DEFAULT_SETTINGS = {
  enabled: true,
  provider: "openai-compatible",
  model: "llama3.2",
  endpoint: "http://localhost:11434/v1",
  apiKey: "",
  models: [createDefaultMainModel()],
  activeMainModelId: DEFAULT_MAIN_MODEL_ID,
  streamResponses: true,
  saveChatHistory: true,
  includeCurrentTweet: true,
  includeVisibleThread: true,
  includeQuotedTweet: true,
  cacheVisitedProfiles: true,
  allowBackgroundProfileScan: false,
  maxRecentProfilePosts: 5,
  allowBackgroundSearch: false,
  backgroundSearchSource: "x",
  webSearchEngines: ["brave", "duckduckgo", "startpage"],
  webSearchCustomTemplate: "",
  maxBackgroundSearchResults: 6,
  maxToolTurns: 6,
  maxMultiLinks: DEFAULT_MULTI_LINKS,
  modelContextTokens: DEFAULT_MODEL_CONTEXT_TOKENS,
  temperature: DEFAULT_TEMPERATURE,
  allowImageAnalysis: true,
  autoReadLinks: true,
  imageUseBaseProvider: true,
  imageModelId: "",
  imageProvider: "openai-compatible",
  imageEndpoint: "",
  imageModel: "",
  imageApiKey: "",
  allowVideoAnalysis: true,
  videoUseBaseProvider: true,
  videoModelId: "",
  videoProvider: "openai-compatible",
  videoEndpoint: "",
  videoModel: "",
  videoApiKey: "",
  videoMergeUseBaseProvider: true,
  videoMergeModelId: "",
  videoMergeProvider: "openai-compatible",
  videoMergeEndpoint: "",
  videoMergeModel: "",
  videoMergeApiKey: "",
  maxVideoFrames: 36,
  videoFramesPerMinute: 12,
  videoFrameIntervalSeconds: 1,
  videoChunkSeconds: DEFAULT_VIDEO_CHUNK_SECONDS,
  videoChunkConcurrency: DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  videoSamplingDefaultsVersion: VIDEO_SAMPLING_DEFAULTS_VERSION,
  allowAudioAnalysis: true,
  audioUseBaseProvider: true,
  audioModelId: "",
  audioProvider: "openai-compatible",
  audioEndpoint: "",
  audioModel: "",
  audioApiKey: "",
  // Orchestration. "local": one model call at a time (a single GPU). "api": many in
  // parallel (hosted providers). "custom": the numbers below.
  performanceProfile: "local",
  parallelModelCalls: 4,
  parallelVideoCaptures: 2,
  autoMediaMaxVideos: 2,
  autoMediaMaxImages: 4,
  // Start reading the post and its media when the panel opens, before the question.
  prefetchOnOpen: false,
  // Let media analysis finish (into the cache) after the ask that started it stops.
  continueMediaInBackground: true,
  // Diagnostics: keep the last raw X responses for export.
  captureXResponses: false
};
export async function openOptionsPage() {
  const url = api.runtime.getURL("options.html");

  if (api.tabs?.create) {
    await api.tabs.create({ url, active: true });
    return;
  }

  if (api.runtime.openOptionsPage) {
    await api.runtime.openOptionsPage();
  }
}
export async function getSettings() {
  const keys = Object.keys(DEFAULT_SETTINGS);
  const [localSettingsResult, syncSettingsResult, localLegacyResult, syncLegacyResult] = await Promise.allSettled([
    api.storage.local.get(SETTINGS_STORE_KEY),
    api.storage.sync.get(SETTINGS_STORE_KEY),
    api.storage.local.get(keys),
    api.storage.sync.get(keys)
  ]);

  const localSettings = localSettingsResult.status === "fulfilled"
    ? localSettingsResult.value?.[SETTINGS_STORE_KEY]
    : null;
  if (isSettingsObject(localSettings)) {
    return sanitizeSettings({
      ...DEFAULT_SETTINGS,
      ...prepareStoredSettings(localSettings)
    });
  }

  const syncSettings = syncSettingsResult.status === "fulfilled"
    ? syncSettingsResult.value?.[SETTINGS_STORE_KEY]
    : null;
  if (isSettingsObject(syncSettings)) {
    return sanitizeSettings({
      ...DEFAULT_SETTINGS,
      ...prepareStoredSettings(syncSettings)
    });
  }

  const localLegacyValues = localLegacyResult.status === "fulfilled" ? localLegacyResult.value : {};
  const syncLegacyValues = syncLegacyResult.status === "fulfilled" ? syncLegacyResult.value : {};
  return sanitizeSettings({
    ...DEFAULT_SETTINGS,
    ...prepareStoredSettings({
      ...migrateVideoSamplingDefaults(syncLegacyValues),
      ...migrateVideoSamplingDefaults(localLegacyValues)
    })
  });
}
export async function saveSettings(input) {
  const existing = await getSettings();
  const settings = sanitizeSettings({
    ...existing,
    ...input
  });

  await api.storage.local.set({ [SETTINGS_STORE_KEY]: settings });
  api.storage.sync.set({ [SETTINGS_STORE_KEY]: settings }).catch(() => {});
  return settings;
}
export function isSettingsObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}
export function migrateVideoSamplingDefaults(input) {
  const output = { ...(input && typeof input === "object" ? input : {}) };
  if (Number(output.videoSamplingDefaultsVersion || 0) >= VIDEO_SAMPLING_DEFAULTS_VERSION) return output;

  const maxFrames = Number(output.maxVideoFrames);
  const framesPerMinute = Number(output.videoFramesPerMinute || 0);
  const interval = Number(output.videoFrameIntervalSeconds);
  // Stock defaults from older versions — bump to current token-efficient sampling.
  const usedStockV1 = maxFrames === 3 && framesPerMinute === 0 && interval === 1;
  const usedStockV2 = maxFrames === 120 && framesPerMinute === 0 && interval === 0.25;
  if (usedStockV1 || usedStockV2) {
    output.maxVideoFrames = DEFAULT_SETTINGS.maxVideoFrames;
    output.videoFramesPerMinute = DEFAULT_SETTINGS.videoFramesPerMinute;
    output.videoFrameIntervalSeconds = DEFAULT_SETTINGS.videoFrameIntervalSeconds;
  }
  output.videoSamplingDefaultsVersion = VIDEO_SAMPLING_DEFAULTS_VERSION;
  return output;
}

/** Apply video/context migrations, then seed models[] from flat fields when missing. */
export function prepareStoredSettings(stored) {
  return migrateModelsFromFlat(migrateContextBudget(migrateVideoSamplingDefaults(stored)));
}

/**
 * maxContextTokens budgeted only the per-question context (system prompt, tools,
 * history, and tool results came on top). modelContextTokens is the model's whole
 * context window, so carry old values over with that overhead added.
 */
export function migrateContextBudget(input) {
  const output = { ...(input && typeof input === "object" ? input : {}) };
  if (output.modelContextTokens !== undefined || output.maxContextTokens === undefined) return output;
  const legacy = Number(output.maxContextTokens);
  if (Number.isFinite(legacy) && legacy > 0) {
    output.modelContextTokens = Math.max(DEFAULT_MODEL_CONTEXT_TOKENS, Math.round((legacy + 2500) / 1024) * 1024);
  }
  return output;
}

/** "" (or null) means "use the provider's default temperature". */
export function normalizeTemperature(value) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TEMPERATURE;
  return Math.round(Math.max(0, Math.min(number, 2)) * 100) / 100;
}
export function sanitizeModelEntry(entry, fallback = {}) {
  const source = entry && typeof entry === "object" ? entry : {};
  const legacyOllama = String(source.provider ?? fallback.provider ?? "").trim().toLowerCase() === "ollama";
  const provider = normalizeProvider(source.provider ?? fallback.provider, DEFAULT_SETTINGS.provider);
  let endpoint = String(source.endpoint ?? fallback.endpoint ?? DEFAULT_SETTINGS.endpoint).trim();
  if (legacyOllama) endpoint = migrateLegacyOllamaEndpoint(endpoint);
  if (provider === "openai-compatible" && endpoint) {
    try {
      endpoint = resolveOpenAICompatibleEndpoint(endpoint);
    } catch {
      // Keep the user's typed value so the provider call can surface a clear error.
    }
  }
  const model = String(source.model ?? fallback.model ?? DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model;
  const name = String(source.name ?? "").trim() || model || "Untitled";
  const id = String(source.id || "").trim() || createModelId();
  return {
    id,
    name,
    provider,
    endpoint,
    model,
    apiKey: String(source.apiKey ?? fallback.apiKey ?? ""),
    usableAsMainText: source.usableAsMainText !== undefined
      ? Boolean(source.usableAsMainText)
      : true
  };
}

export function migrateModelsFromFlat(input) {
  const source = input && typeof input === "object" ? input : {};
  if (Array.isArray(source.models) && source.models.length) return source;

  const seeded = sanitizeModelEntry({
    id: DEFAULT_MAIN_MODEL_ID,
    name: String(source.model || "").trim() || "Default",
    provider: source.provider,
    endpoint: source.endpoint,
    model: source.model,
    apiKey: source.apiKey,
    usableAsMainText: true
  });
  return {
    ...source,
    models: [seeded],
    activeMainModelId: seeded.id
  };
}

export function normalizeModels(input) {
  const source = migrateModelsFromFlat(input);
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(source.models) ? source.models : []) {
    const model = sanitizeModelEntry(entry, {
      provider: source.provider,
      endpoint: source.endpoint,
      model: source.model,
      apiKey: source.apiKey
    });
    if (seen.has(model.id)) model.id = createModelId();
    seen.add(model.id);
    models.push(model);
  }
  if (!models.length) {
    models.push(createDefaultMainModel({
      provider: source.provider,
      endpoint: source.endpoint,
      model: source.model,
      apiKey: source.apiKey,
      name: String(source.model || "").trim() || "Default"
    }));
  }

  let activeMainModelId = String(source.activeMainModelId || "").trim();
  const byId = new Map(models.map((entry) => [entry.id, entry]));
  let active = byId.get(activeMainModelId);
  if (!active || !active.usableAsMainText) {
    active = models.find((entry) => entry.usableAsMainText) || models[0];
    active.usableAsMainText = true;
    activeMainModelId = active.id;
  }

  return {
    models,
    activeMainModelId,
    provider: active.provider,
    endpoint: active.endpoint,
    model: active.model,
    apiKey: active.apiKey
  };
}

export function getActiveMainModel(settings) {
  const normalized = normalizeModels(settings || {});
  return normalized.models.find((entry) => entry.id === normalized.activeMainModelId) || normalized.models[0];
}

export function listMainTextModels(settings) {
  return normalizeModels(settings || {}).models.filter((entry) => entry.usableAsMainText);
}

export function formatModelLabel(settings, { includeApiId = false } = {}) {
  const active = getActiveMainModel(settings);
  if (!active) {
    const provider = settings?.provider || DEFAULT_SETTINGS.provider;
    const model = settings?.model || DEFAULT_SETTINGS.model;
    return `${provider}:${model}`;
  }
  if (includeApiId && active.name && active.name !== active.model) {
    return `${active.name} (${active.provider}:${active.model})`;
  }
  return active.name || `${active.provider}:${active.model}`;
}

export function sanitizeSettings(input) {
  const migrated = migrateModelsFromFlat(input && typeof input === "object" ? input : {});
  const output = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (migrated[key] !== undefined) output[key] = migrated[key];
  }

  const normalizedModels = normalizeModels(migrated);
  output.models = normalizedModels.models;
  output.activeMainModelId = normalizedModels.activeMainModelId;
  output.provider = normalizedModels.provider;
  output.endpoint = normalizedModels.endpoint;
  output.model = normalizedModels.model;
  output.apiKey = normalizedModels.apiKey;

  syncMediaModelSelection(output, "image");
  syncMediaModelSelection(output, "video");
  syncMediaModelSelection(output, "videoMerge");
  syncMediaModelSelection(output, "audio");

  if (output.backgroundSearchSource !== undefined) {
    output.backgroundSearchSource = normalizeSearchSource(output.backgroundSearchSource);
  }
  if (output.performanceProfile !== undefined) {
    output.performanceProfile = normalizePerformanceProfile(output.performanceProfile);
  }
  if (output.parallelModelCalls !== undefined) {
    output.parallelModelCalls = Math.floor(clampNumber(output.parallelModelCalls, 1, 32, DEFAULT_SETTINGS.parallelModelCalls));
  }
  if (output.parallelVideoCaptures !== undefined) {
    output.parallelVideoCaptures = Math.floor(clampNumber(output.parallelVideoCaptures, 1, 6, DEFAULT_SETTINGS.parallelVideoCaptures));
  }
  if (output.autoMediaMaxVideos !== undefined) {
    output.autoMediaMaxVideos = Math.floor(clampNumber(output.autoMediaMaxVideos, 0, 12, DEFAULT_SETTINGS.autoMediaMaxVideos));
  }
  if (output.autoMediaMaxImages !== undefined) {
    output.autoMediaMaxImages = Math.floor(clampNumber(output.autoMediaMaxImages, 0, 32, DEFAULT_SETTINGS.autoMediaMaxImages));
  }
  if (output.webSearchEngines !== undefined) {
    output.webSearchEngines = normalizeWebSearchEngines(output.webSearchEngines);
  }
  if (output.webSearchCustomTemplate !== undefined) {
    output.webSearchCustomTemplate = String(output.webSearchCustomTemplate || "").trim();
  }
  if (output.maxBackgroundSearchResults !== undefined) {
    output.maxBackgroundSearchResults = clampNumber(output.maxBackgroundSearchResults, 1, 12, DEFAULT_SETTINGS.maxBackgroundSearchResults);
  }
  if (output.maxToolTurns !== undefined) {
    output.maxToolTurns = clampNumber(output.maxToolTurns, 1, 50, DEFAULT_SETTINGS.maxToolTurns);
  }
  if (output.maxMultiLinks !== undefined) {
    output.maxMultiLinks = Math.floor(clampNumber(output.maxMultiLinks, MIN_MULTI_LINKS, MAX_MULTI_LINKS, DEFAULT_SETTINGS.maxMultiLinks));
  }
  if (output.modelContextTokens !== undefined) {
    output.modelContextTokens = Math.floor(clampNumber(output.modelContextTokens, MIN_MODEL_CONTEXT_TOKENS, MAX_MODEL_CONTEXT_TOKENS, DEFAULT_SETTINGS.modelContextTokens));
  }
  if (output.temperature !== undefined) {
    output.temperature = normalizeTemperature(output.temperature);
  }
  if (output.maxRecentProfilePosts !== undefined) {
    output.maxRecentProfilePosts = clampNumber(output.maxRecentProfilePosts, 1, 10, DEFAULT_SETTINGS.maxRecentProfilePosts);
  }
  if (output.saveChatHistory !== undefined) {
    output.saveChatHistory = Boolean(output.saveChatHistory);
  }
  if (output.imageProvider !== undefined) {
    output.imageProvider = normalizeProvider(output.imageProvider, DEFAULT_SETTINGS.imageProvider);
  }
  if (output.videoProvider !== undefined) {
    output.videoProvider = normalizeProvider(output.videoProvider, DEFAULT_SETTINGS.videoProvider);
  }
  if (output.audioProvider !== undefined) {
    output.audioProvider = normalizeProvider(output.audioProvider, DEFAULT_SETTINGS.audioProvider);
  }
  if (output.maxVideoFrames !== undefined) {
    output.maxVideoFrames = Math.floor(clampNumber(output.maxVideoFrames, 0, Infinity, DEFAULT_SETTINGS.maxVideoFrames));
  }
  if (output.videoFramesPerMinute !== undefined) {
    output.videoFramesPerMinute = Math.floor(clampNumber(output.videoFramesPerMinute, 0, Infinity, DEFAULT_SETTINGS.videoFramesPerMinute));
  }
  if (output.videoFrameIntervalSeconds !== undefined) {
    output.videoFrameIntervalSeconds = clampNumber(output.videoFrameIntervalSeconds, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, DEFAULT_SETTINGS.videoFrameIntervalSeconds);
  }
  if (output.videoChunkSeconds !== undefined) {
    output.videoChunkSeconds = clampNumber(output.videoChunkSeconds, MIN_VIDEO_CHUNK_SECONDS, MAX_VIDEO_CHUNK_SECONDS, DEFAULT_SETTINGS.videoChunkSeconds);
  }
  if (output.videoChunkConcurrency !== undefined) {
    output.videoChunkConcurrency = Math.floor(clampNumber(
      output.videoChunkConcurrency,
      MIN_VIDEO_CHUNK_CONCURRENCY,
      MAX_VIDEO_CHUNK_CONCURRENCY,
      DEFAULT_SETTINGS.videoChunkConcurrency
    ));
  }
  return output;
}

/**
 * Resolve image/video/audio analysis to a models[] entry (or the active main model).
 * Empty `${prefix}ModelId` means "use active main text model".
 * kind: "image" | "video" | "videoMerge" | "audio"
 */
export function getMediaModel(settings, kind) {
  const prefix = mediaKindPrefix(kind);
  const models = Array.isArray(settings?.models) ? settings.models : [];
  const activeId = String(settings?.activeMainModelId || "").trim();
  const selectedId = String(settings?.[`${prefix}ModelId`] || "").trim();
  if (!selectedId || selectedId === activeId || settings?.[`${prefix}UseBaseProvider`]) {
    return getActiveMainModel(settings);
  }
  return models.find((entry) => entry.id === selectedId) || getActiveMainModel(settings);
}

function mediaKindPrefix(kind) {
  if (kind === "videoMerge") return "videoMerge";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  return "image";
}

function mediaKindLegacyLabel(prefix) {
  if (prefix === "videoMerge") return "Video merge";
  if (prefix === "video") return "Video analysis";
  if (prefix === "audio") return "Audio analysis";
  return "Image analysis";
}

/** Text-only video window merge — defaults to the main text model (larger context). */
export function getVideoMergeModel(settings) {
  return getMediaModel(settings, "videoMerge");
}

function syncMediaModelSelection(output, prefix) {
  const models = Array.isArray(output.models) ? output.models : [];
  const byId = new Map(models.map((entry) => [entry.id, entry]));
  let modelId = String(output[`${prefix}ModelId`] || "").trim();

  if (modelId && byId.has(modelId)) {
    // Keep explicit selection.
  } else if (output[`${prefix}UseBaseProvider`] === false) {
    // Legacy dedicated image/video fields → match or import into models[].
    const legacyModel = String(output[`${prefix}Model`] || "").trim();
    const legacyProvider = normalizeProvider(output[`${prefix}Provider`], DEFAULT_SETTINGS[`${prefix}Provider`]);
    const legacyEndpoint = String(output[`${prefix}Endpoint`] || "").trim();
    if (legacyModel) {
      const match = models.find((entry) => (
        entry.model === legacyModel
        && entry.provider === legacyProvider
        && (!legacyEndpoint || entry.endpoint === legacyEndpoint)
      ));
      if (match) {
        modelId = match.id;
      } else {
        const imported = sanitizeModelEntry({
          name: mediaKindLegacyLabel(prefix),
          provider: legacyProvider,
          endpoint: legacyEndpoint,
          model: legacyModel,
          apiKey: output[`${prefix}ApiKey`] || "",
          usableAsMainText: false
        });
        models.push(imported);
        byId.set(imported.id, imported);
        modelId = imported.id;
        output.models = models;
      }
    } else {
      modelId = "";
    }
  } else {
    modelId = "";
  }

  if (modelId && !byId.has(modelId)) modelId = "";

  const useBase = !modelId || modelId === output.activeMainModelId;
  output[`${prefix}ModelId`] = useBase ? "" : modelId;
  output[`${prefix}UseBaseProvider`] = useBase;

  const selected = useBase
    ? byId.get(output.activeMainModelId) || models[0]
    : byId.get(modelId);
  if (selected) {
    output[`${prefix}Provider`] = selected.provider;
    output[`${prefix}Endpoint`] = selected.endpoint;
    output[`${prefix}Model`] = selected.model;
    output[`${prefix}ApiKey`] = selected.apiKey;
  }
}
export function normalizeProfile(profile) {
  if (!profile || !profile.handle) return null;
  return {
    handle: String(profile.handle).replace(/^@/, ""),
    displayName: profile.displayName ? String(profile.displayName) : "",
    bio: profile.bio ? String(profile.bio) : "",
    recentPosts: Array.isArray(profile.recentPosts) ? profile.recentPosts.slice(0, 10).map(String) : []
  };
}
export function normalizeSearchSource(value) {
  const source = String(value || "").trim().toLowerCase();
  return ["x", "web", "both"].includes(source) ? source : DEFAULT_SETTINGS.backgroundSearchSource;
}
export function normalizeWebSearchEngines(value) {
  if (!Array.isArray(value)) return DEFAULT_SETTINGS.webSearchEngines.slice();
  const known = new Set(Object.keys(SEARCH_ENGINE_REGISTRY));
  known.add("custom");
  const list = value
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter((entry) => entry && known.has(entry));
  return list.length ? Array.from(new Set(list)) : DEFAULT_SETTINGS.webSearchEngines.slice();
}
export function normalizeProvider(value, fallback = DEFAULT_SETTINGS.provider) {
  const provider = String(value || "").trim().toLowerCase();
  // Legacy "ollama" entries migrate to the OpenAI-compatible provider.
  return provider === "openai-compatible" || provider === "ollama" ? "openai-compatible" : fallback;
}

/** Legacy Ollama /api/generate or /api/chat endpoints map to the OpenAI-compatible /v1 base. */
function migrateLegacyOllamaEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (/\/api\/(generate|chat)$/.test(url.pathname)) {
      url.pathname = "/v1";
      return url.href;
    }
  } catch {
    // Keep the user's typed value.
  }
  return endpoint;
}

