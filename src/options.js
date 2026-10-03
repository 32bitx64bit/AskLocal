const api = globalThis.browser ?? globalThis.chrome;
const SETTINGS_STORE_KEY = "asklocalSettings";
const VIDEO_SAMPLING_DEFAULTS_VERSION = 3;
const MIN_VIDEO_FRAME_INTERVAL_SECONDS = 0.2;
const MIN_VIDEO_CHUNK_SECONDS = 10;
const MAX_VIDEO_CHUNK_SECONDS = 60;
const DEFAULT_VIDEO_CHUNK_SECONDS = 30;
const MIN_VIDEO_CHUNK_CONCURRENCY = 1;
const MAX_VIDEO_CHUNK_CONCURRENCY = 8;
const DEFAULT_VIDEO_CHUNK_CONCURRENCY = 1;
const MIN_MULTI_LINKS = 1;
const MAX_MULTI_LINKS = 8;
const DEFAULT_MULTI_LINKS = 4;

function setEmbeddedTheme(theme) {
  document.documentElement.dataset.asklocalTheme = theme === "dark" ? "dark" : "light";
}

window.addEventListener("message", (event) => {
  if (event.data?.type !== "ASKLOCAL_SET_THEME") return;
  setEmbeddedTheme(event.data.theme);
});

const defaultFormSettings = {
  enabled: true,
  provider: "openai-compatible",
  endpoint: "http://localhost:11434/v1",
  model: "llama3.2",
  apiKey: "",
  models: [],
  activeMainModelId: "",
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
  modelContextTokens: 32768,
  temperature: 0.3,
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
  performanceProfile: "local",
  parallelModelCalls: 4,
  parallelVideoCaptures: 2,
  autoMediaMaxVideos: 2,
  autoMediaMaxImages: 4,
  prefetchOnOpen: false,
  continueMediaInBackground: true,
  captureXResponses: false
};

const fields = [
  "streamResponses",
  "saveChatHistory",
  "includeCurrentTweet",
  "includeVisibleThread",
  "includeQuotedTweet",
  "cacheVisitedProfiles",
  "allowBackgroundProfileScan",
  "maxRecentProfilePosts",
  "allowBackgroundSearch",
  "backgroundSearchSource",
  "webSearchCustomTemplate",
  "maxBackgroundSearchResults",
  "maxToolTurns",
  "maxMultiLinks",
  "modelContextTokens",
  "temperature",
  "allowImageAnalysis",
  "autoReadLinks",
  "allowVideoAnalysis",
  "allowAudioAnalysis",
  "maxVideoFrames",
  "videoFramesPerMinute",
  "videoFrameIntervalSeconds",
  "videoChunkSeconds",
  "videoChunkConcurrency",
  "performanceProfile",
  "parallelModelCalls",
  "parallelVideoCaptures",
  "autoMediaMaxVideos",
  "autoMediaMaxImages",
  "prefetchOnOpen",
  "continueMediaInBackground",
  "captureXResponses"
];

/** @type {{ id: string, name: string, provider: string, endpoint: string, model: string, apiKey: string, usableAsMainText: boolean }[]} */
let draftModels = [];
let draftActiveMainModelId = "";
let draftImageModelId = "";
let draftVideoModelId = "";
let draftVideoMergeModelId = "";
let draftAudioModelId = "";

init();

async function init() {
  try {
    const response = await api.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (!response?.ok) throw new Error(response?.error || "Could not load AskLocal settings.");
    const localSettings = await readStoredSettings();
    setForm(mergeSettings(response.settings, localSettings));
    updateSearchFields();
    updateMediaFields();
    document.querySelector("#allowBackgroundSearch").addEventListener("change", updateSearchFields);
    document.querySelector("#webSearchEngines").addEventListener("change", updateWebSearchCustomVisibility);
    for (const id of ["allowImageAnalysis", "allowVideoAnalysis", "allowAudioAnalysis"]) {
      document.querySelector(`#${id}`).addEventListener("change", updateMediaFields);
    }
    document.querySelector("#imageModelId").addEventListener("change", (event) => {
      draftImageModelId = event.target.value;
      updateMediaFields();
    });
    document.querySelector("#videoModelId").addEventListener("change", (event) => {
      draftVideoModelId = event.target.value;
      updateMediaFields();
    });
    document.querySelector("#videoMergeModelId").addEventListener("change", (event) => {
      draftVideoMergeModelId = event.target.value;
      updateMediaFields();
    });
    document.querySelector("#audioModelId").addEventListener("change", (event) => {
      draftAudioModelId = event.target.value;
      updateMediaFields();
    });
    document.querySelector("#addModel").addEventListener("click", () => {
      addDraftModel();
      renderModelsList();
      syncActiveMainSelect();
      syncMediaModelSelects();
    });
    document.querySelector("#activeMainModelId").addEventListener("change", (event) => {
      draftActiveMainModelId = event.target.value;
      renderModelsList();
      syncMediaModelSelects();
    });
    document.querySelector("#performanceProfile").addEventListener("change", updatePerformanceFields);
    document.querySelector("#clearMediaCache").addEventListener("click", clearMediaCache);
    document.querySelector("#exportXCaptures").addEventListener("click", exportXCaptures);
    document.querySelector("#clearXCaptures").addEventListener("click", clearXCaptures);
    updatePerformanceFields();
    void refreshMediaCacheStatus();
    document.querySelector("#save").addEventListener("click", save);
    document.querySelector("#testConnection").addEventListener("click", testConnection);
  } catch (error) {
    document.querySelector("#status").textContent = error.message || "Could not load settings.";
  }
}

function createModelId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Fall through.
  }
  return `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createBlankModel(overrides = {}) {
  return {
    id: createModelId(),
    name: "",
    provider: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: "",
    apiKey: "",
    usableAsMainText: true,
    ...overrides
  };
}

function setForm(settings) {
  const merged = mergeSettings(settings);
  for (const field of fields) {
    const input = document.querySelector(`#${field}`);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(merged[field]);
    else input.value = merged[field] ?? "";
  }
  const enginesSelect = document.querySelector("#webSearchEngines");
  if (enginesSelect) {
    const selected = new Set(Array.isArray(merged.webSearchEngines) ? merged.webSearchEngines : []);
    Array.from(enginesSelect.options).forEach((option) => {
      option.selected = selected.has(option.value);
    });
  }

  draftModels = Array.isArray(merged.models) && merged.models.length
    ? merged.models.map((entry) => ({ ...entry }))
    : [createBlankModel({
      name: merged.model || "Default",
      provider: merged.provider,
      endpoint: merged.endpoint,
      model: merged.model,
      apiKey: merged.apiKey,
      usableAsMainText: true
    })];
  draftActiveMainModelId = merged.activeMainModelId || draftModels.find((entry) => entry.usableAsMainText)?.id || draftModels[0].id;
  draftImageModelId = merged.imageUseBaseProvider || !merged.imageModelId ? "" : merged.imageModelId;
  draftVideoModelId = merged.videoUseBaseProvider || !merged.videoModelId ? "" : merged.videoModelId;
  draftVideoMergeModelId = merged.videoMergeUseBaseProvider || !merged.videoMergeModelId ? "" : merged.videoMergeModelId;
  draftAudioModelId = merged.audioUseBaseProvider || !merged.audioModelId ? "" : merged.audioModelId;
  renderModelsList();
  syncActiveMainSelect();
  syncMediaModelSelects();
  updateMediaFields();
}

function addDraftModel() {
  const model = createBlankModel({ name: `Model ${draftModels.length + 1}` });
  draftModels.push(model);
  if (!draftModels.some((entry) => entry.id === draftActiveMainModelId && entry.usableAsMainText)) {
    draftActiveMainModelId = model.id;
  }
}

function readModelCard(card) {
  const id = card.getAttribute("data-model-id");
  return {
    id,
    name: card.querySelector('[data-field="name"]').value.trim(),
    provider: "openai-compatible",
    endpoint: card.querySelector('[data-field="endpoint"]').value.trim(),
    model: card.querySelector('[data-field="model"]').value.trim(),
    apiKey: card.querySelector('[data-field="apiKey"]').value,
    usableAsMainText: card.querySelector('[data-field="usableAsMainText"]').checked
  };
}

function syncDraftModelsFromDom() {
  const cards = [...document.querySelectorAll("#modelsList .model-card")];
  if (!cards.length) return;
  const byId = new Map(draftModels.map((entry) => [entry.id, entry]));
  draftModels = cards.map((card) => {
    const next = readModelCard(card);
    const prev = byId.get(next.id);
    return prev ? { ...prev, ...next } : next;
  });
}

function renderModelsList() {
  const list = document.querySelector("#modelsList");
  list.textContent = "";

  draftModels.forEach((entry, index) => {
    const card = document.createElement("article");
    card.className = "model-card";
    card.setAttribute("data-model-id", entry.id);
    const isActive = entry.id === draftActiveMainModelId;
    card.innerHTML = `
      <div class="model-card-header">
        <strong></strong>
        <span class="active-badge" ${isActive ? "" : "hidden"}>Active main</span>
      </div>
      <div class="model-fields">
        <label>
          <span>Display name</span>
          <input data-field="name" type="text" placeholder="Friendly name">
        </label>
        <label>
          <span>Endpoint</span>
          <input data-field="endpoint" type="url" placeholder="http://localhost:11434/v1">
        </label>
        <label>
          <span>API model ID</span>
          <input data-field="model" type="text" list="modelSuggestions" placeholder="llama3.2">
        </label>
        <label>
          <span>API key</span>
          <input data-field="apiKey" type="password" autocomplete="off" placeholder="Optional for local endpoints">
        </label>
        <label class="check">
          <input data-field="usableAsMainText" type="checkbox">
          Usable as main text model
        </label>
      </div>
      <div class="model-card-actions">
        <button type="button" class="secondary" data-action="set-active">Set as active</button>
        <button type="button" class="secondary" data-action="remove">Remove</button>
      </div>
      <p class="hint" data-provider-hint></p>
    `;
    card.querySelector(".model-card-header strong").textContent = entry.name || entry.model || `Model ${index + 1}`;
    card.querySelector('[data-field="name"]').value = entry.name || "";
    card.querySelector('[data-field="endpoint"]').value = entry.endpoint || "";
    card.querySelector('[data-field="model"]').value = entry.model || "";
    card.querySelector('[data-field="apiKey"]').value = entry.apiKey || "";
    card.querySelector('[data-field="usableAsMainText"]').checked = entry.usableAsMainText !== false;
    updateModelCardHints(card);
    wireModelCard(card);
    list.appendChild(card);
  });
}

function wireModelCard(card) {
  const onFieldChange = () => {
    syncDraftModelsFromDom();
    const entry = draftModels.find((item) => item.id === card.getAttribute("data-model-id"));
    if (entry) {
      card.querySelector(".model-card-header strong").textContent = entry.name || entry.model || "Untitled";
    }
    updateModelCardHints(card);
    syncActiveMainSelect();
    renderActiveBadges();
  };

  for (const input of card.querySelectorAll("[data-field]")) {
    input.addEventListener("change", onFieldChange);
    input.addEventListener("input", onFieldChange);
  }

  card.querySelector('[data-field="endpoint"]').addEventListener("blur", () => {
    const endpoint = card.querySelector('[data-field="endpoint"]');
    endpoint.value = normalizeOpenAICompatibleEndpointValue(endpoint.value);
    onFieldChange();
  });

  card.querySelector('[data-action="set-active"]').addEventListener("click", () => {
    syncDraftModelsFromDom();
    const id = card.getAttribute("data-model-id");
    const entry = draftModels.find((item) => item.id === id);
    if (!entry) return;
    entry.usableAsMainText = true;
    card.querySelector('[data-field="usableAsMainText"]').checked = true;
    draftActiveMainModelId = id;
    syncActiveMainSelect();
    renderActiveBadges();
  });

  card.querySelector('[data-action="remove"]').addEventListener("click", () => {
    syncDraftModelsFromDom();
    if (draftModels.length <= 1) {
      document.querySelector("#status").textContent = "Keep at least one model.";
      return;
    }
    const id = card.getAttribute("data-model-id");
    draftModels = draftModels.filter((item) => item.id !== id);
    if (draftActiveMainModelId === id) {
      draftActiveMainModelId = draftModels.find((item) => item.usableAsMainText)?.id || draftModels[0].id;
    }
    renderModelsList();
    syncActiveMainSelect();
  });
}

function renderActiveBadges() {
  for (const card of document.querySelectorAll("#modelsList .model-card")) {
    const badge = card.querySelector(".active-badge");
    const active = card.getAttribute("data-model-id") === draftActiveMainModelId;
    badge.hidden = !active;
  }
}

function updateModelCardHints(card) {
  const endpoint = card.querySelector('[data-field="endpoint"]');
  const model = card.querySelector('[data-field="model"]');
  const apiKey = card.querySelector('[data-field="apiKey"]');
  const hint = card.querySelector("[data-provider-hint]");
  const setActive = card.querySelector('[data-action="set-active"]');
  const usable = card.querySelector('[data-field="usableAsMainText"]').checked;
  setActive.disabled = !usable;

  endpoint.placeholder = "http://localhost:1234/v1 or https://api.openai.com/v1";
  model.placeholder = "gpt-4.1-mini, llama-3.2-3b-instruct, or any compatible model";
  apiKey.placeholder = "Optional for localhost, required by most hosted providers";
  hint.textContent = "Base URLs ending in /v1 are saved as the full /v1/chat/completions URL.";
}

function syncActiveMainSelect() {
  const select = document.querySelector("#activeMainModelId");
  const usable = draftModels.filter((entry) => entry.usableAsMainText);
  const options = usable.length ? usable : draftModels;
  select.textContent = "";
  for (const entry of options) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name || entry.model || entry.id;
    select.appendChild(option);
  }
  if (!options.some((entry) => entry.id === draftActiveMainModelId) && options[0]) {
    draftActiveMainModelId = options[0].id;
  }
  select.value = draftActiveMainModelId;
  renderActiveBadges();
  syncMediaModelSelects();
}

function syncMediaModelSelects() {
  fillMediaModelSelect("image", draftImageModelId);
  fillMediaModelSelect("video", draftVideoModelId);
  fillMediaModelSelect("videoMerge", draftVideoMergeModelId, {
    activeLabel: "Active main text model (recommended for merge)"
  });
  fillMediaModelSelect("audio", draftAudioModelId);
  draftImageModelId = document.querySelector("#imageModelId")?.value || "";
  draftVideoModelId = document.querySelector("#videoModelId")?.value || "";
  draftVideoMergeModelId = document.querySelector("#videoMergeModelId")?.value || "";
  draftAudioModelId = document.querySelector("#audioModelId")?.value || "";
}

function fillMediaModelSelect(prefix, selectedId, options = {}) {
  const select = document.querySelector(`#${prefix}ModelId`);
  if (!select) return;
  const previous = selectedId || "";
  select.textContent = "";

  const activeOption = document.createElement("option");
  activeOption.value = "";
  const active = draftModels.find((entry) => entry.id === draftActiveMainModelId);
  const activeLabel = options.activeLabel || "Active main text model";
  activeOption.textContent = active
    ? `${activeLabel} (${active.name || active.model || active.id})`
    : activeLabel;
  select.appendChild(activeOption);

  for (const entry of draftModels) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name || entry.model || entry.id;
    select.appendChild(option);
  }

  if (previous && draftModels.some((entry) => entry.id === previous) && previous !== draftActiveMainModelId) {
    select.value = previous;
  } else {
    select.value = "";
  }
}

async function save() {
  const payload = collectFormSettings();
  const status = document.querySelector("#status");
  status.textContent = "Saving...";

  try {
    const directSettings = mergeSettings(await readStoredSettings(), payload);
    await writeStoredSettings(directSettings);

    const response = await api.runtime.sendMessage({ type: "SAVE_SETTINGS", payload });
    if (!response?.ok) {
      status.textContent = response?.error || "Could not save settings.";
      return;
    }

    const savedSettings = mergeSettings(response.settings, directSettings);
    await writeStoredSettings(savedSettings);
    setForm(savedSettings);
    updateSearchFields();
    updateMediaFields();
    updatePerformanceFields();
    status.textContent = buildSavedStatus(response, savedSettings);
    setTimeout(() => {
      status.textContent = "";
    }, 2600);
  } catch (error) {
    status.textContent = error.message || "Could not save settings.";
  }
}

async function testConnection() {
  const status = document.querySelector("#testStatus");
  const button = document.querySelector("#testConnection");
  status.textContent = "Testing...";
  button.disabled = true;

  syncDraftModelsFromDom();
  const active = draftModels.find((entry) => entry.id === draftActiveMainModelId) || draftModels[0];
  if (!active) {
    status.textContent = "Add a model first.";
    button.disabled = false;
    return;
  }

  let endpoint = active.endpoint;
  if (active.provider === "openai-compatible") {
    endpoint = normalizeOpenAICompatibleEndpointValue(endpoint);
  }

  try {
    const response = await api.runtime.sendMessage({
      type: "TEST_PROVIDER",
      payload: {
        provider: active.provider,
        endpoint,
        model: active.model,
        apiKey: active.apiKey
      }
    });
    if (!response?.ok) {
      status.textContent = response?.error || "Connection failed.";
      return;
    }

    status.textContent = response.detail || "Connected.";
    const datalist = document.querySelector("#modelSuggestions");
    datalist.textContent = "";
    (response.models ?? []).slice(0, 80).forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      datalist.appendChild(option);
    });
  } catch (error) {
    status.textContent = error.message || "Connection failed.";
  } finally {
    button.disabled = false;
  }
}

function collectFormSettings() {
  syncDraftModelsFromDom();
  const payload = {};
  for (const field of fields) {
    const input = document.querySelector(`#${field}`);
    if (!input) continue;
    if (input.type === "checkbox") payload[field] = input.checked;
    else if (field === "temperature") payload[field] = input.value.trim() === "" ? "" : Number(input.value);
    else if (input.type === "number") payload[field] = Number(input.value);
    else payload[field] = input.value.trim();
  }
  const enginesSelect = document.querySelector("#webSearchEngines");
  if (enginesSelect) {
    payload.webSearchEngines = Array.from(enginesSelect.selectedOptions).map((option) => option.value);
  }

  payload.models = draftModels.map((entry) => {
    const next = { ...entry };
    if (next.provider === "openai-compatible") {
      next.endpoint = normalizeOpenAICompatibleEndpointValue(next.endpoint);
    }
    if (!next.name.trim()) next.name = next.model || "Untitled";
    return next;
  });
  payload.activeMainModelId = draftActiveMainModelId;
  payload.imageModelId = document.querySelector("#imageModelId")?.value || "";
  payload.videoModelId = document.querySelector("#videoModelId")?.value || "";
  payload.videoMergeModelId = document.querySelector("#videoMergeModelId")?.value || "";
  payload.audioModelId = document.querySelector("#audioModelId")?.value || "";
  payload.imageUseBaseProvider = !payload.imageModelId || payload.imageModelId === draftActiveMainModelId;
  payload.videoUseBaseProvider = !payload.videoModelId || payload.videoModelId === draftActiveMainModelId;
  payload.videoMergeUseBaseProvider = !payload.videoMergeModelId || payload.videoMergeModelId === draftActiveMainModelId;
  payload.audioUseBaseProvider = !payload.audioModelId || payload.audioModelId === draftActiveMainModelId;
  if (payload.imageUseBaseProvider) payload.imageModelId = "";
  if (payload.videoUseBaseProvider) payload.videoModelId = "";
  if (payload.videoMergeUseBaseProvider) payload.videoMergeModelId = "";
  if (payload.audioUseBaseProvider) payload.audioModelId = "";
  return payload;
}

async function readStoredSettings() {
  try {
    const result = await api.storage.local.get(SETTINGS_STORE_KEY);
    const settings = result?.[SETTINGS_STORE_KEY];
    return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  } catch {
    return {};
  }
}

async function writeStoredSettings(settings) {
  await api.storage.local.set({ [SETTINGS_STORE_KEY]: mergeSettings(settings) });
}

function mergeSettings(...sources) {
  const merged = { ...defaultFormSettings };
  for (const source of sources) {
    if (source && typeof source === "object") Object.assign(merged, migrateVideoSamplingDefaults(source));
  }
  merged.backgroundSearchSource = ["x", "web", "both"].includes(merged.backgroundSearchSource)
    ? merged.backgroundSearchSource
    : defaultFormSettings.backgroundSearchSource;
  merged.webSearchEngines = Array.isArray(merged.webSearchEngines) && merged.webSearchEngines.length
    ? merged.webSearchEngines.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : defaultFormSettings.webSearchEngines.slice();
  merged.webSearchCustomTemplate = String(merged.webSearchCustomTemplate || "").trim();
  merged.maxRecentProfilePosts = clampNumber(merged.maxRecentProfilePosts, 1, 10, defaultFormSettings.maxRecentProfilePosts);
  merged.maxBackgroundSearchResults = clampNumber(merged.maxBackgroundSearchResults, 1, 12, defaultFormSettings.maxBackgroundSearchResults);
  merged.maxToolTurns = clampNumber(merged.maxToolTurns, 1, 50, defaultFormSettings.maxToolTurns);
  merged.maxMultiLinks = Math.floor(clampNumber(merged.maxMultiLinks, MIN_MULTI_LINKS, MAX_MULTI_LINKS, defaultFormSettings.maxMultiLinks));
  merged.modelContextTokens = Math.floor(clampNumber(merged.modelContextTokens, 2048, 262144, defaultFormSettings.modelContextTokens));
  merged.temperature = merged.temperature === "" || merged.temperature === null
    ? ""
    : clampNumber(merged.temperature, 0, 2, defaultFormSettings.temperature);
  merged.imageProvider = normalizeProvider(merged.imageProvider, defaultFormSettings.imageProvider);
  merged.videoProvider = normalizeProvider(merged.videoProvider, defaultFormSettings.videoProvider);
  merged.maxVideoFrames = Math.floor(clampNumber(merged.maxVideoFrames, 0, Infinity, defaultFormSettings.maxVideoFrames));
  merged.videoFramesPerMinute = Math.floor(clampNumber(merged.videoFramesPerMinute, 0, Infinity, defaultFormSettings.videoFramesPerMinute));
  merged.videoFrameIntervalSeconds = clampNumber(merged.videoFrameIntervalSeconds, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, defaultFormSettings.videoFrameIntervalSeconds);
  merged.videoChunkSeconds = clampNumber(merged.videoChunkSeconds, MIN_VIDEO_CHUNK_SECONDS, MAX_VIDEO_CHUNK_SECONDS, defaultFormSettings.videoChunkSeconds);
  merged.videoChunkConcurrency = Math.floor(clampNumber(
    merged.videoChunkConcurrency,
    MIN_VIDEO_CHUNK_CONCURRENCY,
    MAX_VIDEO_CHUNK_CONCURRENCY,
    defaultFormSettings.videoChunkConcurrency
  ));

  if (!Array.isArray(merged.models) || !merged.models.length) {
    merged.models = [createBlankModel({
      id: "default-main",
      name: String(merged.model || "").trim() || "Default",
      provider: merged.provider || "openai-compatible",
      endpoint: merged.endpoint || defaultFormSettings.endpoint,
      model: merged.model || defaultFormSettings.model,
      apiKey: merged.apiKey || "",
      usableAsMainText: true
    })];
    merged.activeMainModelId = merged.models[0].id;
  }
  if (!merged.activeMainModelId) {
    merged.activeMainModelId = merged.models.find((entry) => entry.usableAsMainText)?.id || merged.models[0].id;
  }
  return merged;
}

function migrateVideoSamplingDefaults(input) {
  const output = { ...(input && typeof input === "object" ? input : {}) };
  if (Number(output.videoSamplingDefaultsVersion || 0) >= VIDEO_SAMPLING_DEFAULTS_VERSION) return output;

  const maxFrames = Number(output.maxVideoFrames);
  const framesPerMinute = Number(output.videoFramesPerMinute || 0);
  const interval = Number(output.videoFrameIntervalSeconds);
  const usedStockV1 = maxFrames === 3 && framesPerMinute === 0 && interval === 1;
  const usedStockV2 = maxFrames === 120 && framesPerMinute === 0 && interval === 0.25;
  if (usedStockV1 || usedStockV2) {
    output.maxVideoFrames = defaultFormSettings.maxVideoFrames;
    output.videoFramesPerMinute = defaultFormSettings.videoFramesPerMinute;
    output.videoFrameIntervalSeconds = defaultFormSettings.videoFrameIntervalSeconds;
  }
  output.videoSamplingDefaultsVersion = VIDEO_SAMPLING_DEFAULTS_VERSION;
  return output;
}

function buildSavedStatus(response, settings) {
  const version = response.version ? `v${response.version}` : "stale background";
  const active = Array.isArray(settings.models)
    ? settings.models.find((entry) => entry.id === settings.activeMainModelId)
    : null;
  const modelLabel = active?.name || settings.model || "model";
  return `Saved (${version}, ${modelLabel}, search ${settings.allowBackgroundSearch ? "on" : "off"} / ${settings.backgroundSearchSource} / ${settings.maxBackgroundSearchResults}, media ${settings.allowImageAnalysis || settings.allowVideoAnalysis || settings.allowAudioAnalysis ? "on" : "off"})`;
}

function updateSearchFields() {
  const enabled = document.querySelector("#allowBackgroundSearch").checked;
  document.querySelector("#backgroundSearchSource").disabled = !enabled;
  document.querySelector("#maxBackgroundSearchResults").disabled = !enabled;
  document.querySelector("#webSearchEngines").disabled = !enabled;
  updateWebSearchCustomVisibility();
}

function updateWebSearchCustomVisibility() {
  const select = document.querySelector("#webSearchEngines");
  const label = document.querySelector("#webSearchCustomTemplateLabel");
  const input = document.querySelector("#webSearchCustomTemplate");
  if (!select || !label || !input) return;
  const enabled = document.querySelector("#allowBackgroundSearch").checked;
  const customSelected = Array.from(select.selectedOptions).some((option) => option.value === "custom");
  label.hidden = !customSelected || !enabled;
  input.disabled = !customSelected || !enabled;
}

function updateMediaFields() {
  updateMediaFieldGroup("image");
  updateMediaFieldGroup("video");
  updateMediaFieldGroup("audio");
  updateVideoMergeFields();
}

function updateVideoMergeFields() {
  const enabled = document.querySelector("#allowVideoAnalysis").checked;
  const select = document.querySelector("#videoMergeModelId");
  const hint = document.querySelector("#videoMergeProviderHint");
  if (select) select.disabled = !enabled;
  if (!hint) return;

  if (!enabled) {
    hint.textContent = "Video analysis is disabled.";
    return;
  }

  const selectedId = select?.value || "";
  const selected = selectedId
    ? draftModels.find((entry) => entry.id === selectedId)
    : draftModels.find((entry) => entry.id === draftActiveMainModelId) || draftModels[0];
  if (!selected) {
    hint.textContent = "Add a model in the Models section first.";
    return;
  }
  const usingMain = !selectedId || selectedId === draftActiveMainModelId;
  hint.textContent = usingMain
    ? `Merge uses the active main text model (${selected.name || selected.model}). Prefer a larger-context text model — vision models often cannot fit the merge prompt.`
    : `Merge uses ${selected.name || selected.model} (${selected.provider}). Prefer a larger-context text model for parallel video merges.`;
}

function updateMediaFieldGroup(prefix) {
  const enabled = document.querySelector(`#allow${capitalize(prefix)}Analysis`).checked;
  const select = document.querySelector(`#${prefix}ModelId`);
  const hint = document.querySelector(`#${prefix}ProviderHint`);
  if (select) select.disabled = !enabled;

  if (prefix === "video") {
    document.querySelector("#maxVideoFrames").disabled = !enabled;
    document.querySelector("#videoFramesPerMinute").disabled = !enabled;
    document.querySelector("#videoFrameIntervalSeconds").disabled = !enabled;
    document.querySelector("#videoChunkSeconds").disabled = !enabled;
    updatePerformanceFields();
  }

  if (!enabled) {
    if (hint) hint.textContent = `${capitalize(prefix)} analysis is disabled.`;
    return;
  }

  const selectedId = select?.value || "";
  const selected = selectedId
    ? draftModels.find((entry) => entry.id === selectedId)
    : draftModels.find((entry) => entry.id === draftActiveMainModelId) || draftModels[0];
  if (!selected) {
    if (hint) hint.textContent = "Add a model in the Models section first.";
    return;
  }
  const usingMain = !selectedId || selectedId === draftActiveMainModelId;
  if (hint) {
    const capability = prefix === "audio"
      ? "an OpenAI-compatible model that accepts audio input"
      : "a vision-capable model";
    hint.textContent = usingMain
      ? `Uses the active main text model (${selected.name || selected.model}). Prefer ${capability}.`
      : `Uses ${selected.name || selected.model} (${selected.provider}). Prefer ${capability}.`;
  }
}

function normalizeOpenAICompatibleEndpointValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  const pathname = normalizeUrlPathname(url.pathname);
  if (pathname.endsWith("/chat/completions")) {
    url.pathname = pathname;
    return url.href;
  }

  if (pathname.endsWith("/v1")) {
    url.pathname = `${pathname}/chat/completions`;
    return url.href;
  }

  if (pathname === "/") {
    url.pathname = "/v1/chat/completions";
    return url.href;
  }

  return raw;
}

function normalizeUrlPathname(pathname) {
  const cleaned = `/${String(pathname || "")
    .split("/")
    .filter(Boolean)
    .join("/")}`;
  return cleaned === "/" ? "/" : cleaned.replace(/\/+$/, "");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function normalizeProvider(value, fallback) {
  const provider = String(value || "").trim().toLowerCase();
  // Legacy "ollama" entries migrate to the OpenAI-compatible provider.
  return provider === "openai-compatible" || provider === "ollama" ? "openai-compatible" : fallback;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}

function updatePerformanceFields() {
  const custom = document.querySelector("#performanceProfile").value === "custom";
  for (const id of ["parallelModelCalls", "parallelVideoCaptures", "autoMediaMaxVideos", "autoMediaMaxImages"]) {
    document.querySelector(`#${id}`).disabled = !custom;
  }
  // Outside Custom the profile sets how many video windows run at once.
  const videoEnabled = document.querySelector("#allowVideoAnalysis").checked;
  document.querySelector("#videoChunkConcurrency").disabled = !custom || !videoEnabled;
}

async function refreshMediaCacheStatus() {
  const status = document.querySelector("#mediaCacheStatus");
  try {
    const response = await api.runtime.sendMessage({ type: "GET_ORCHESTRATION_STATUS" });
    if (!response?.ok) return;
    const count = Number(response.mediaCacheEntries || 0);
    const running = Array.isArray(response.tasks) ? response.tasks.length : 0;
    status.textContent = `${count} cached media analys${count === 1 ? "is" : "es"}${running ? `, ${running} task${running === 1 ? "" : "s"} running` : ""}`;
  } catch {
    status.textContent = "";
  }
}

async function clearMediaCache() {
  const status = document.querySelector("#mediaCacheStatus");
  try {
    const response = await api.runtime.sendMessage({ type: "CLEAR_MEDIA_CACHE" });
    status.textContent = response?.ok ? `Cleared ${response.removed ?? 0}.` : response?.error || "Could not clear the cache.";
  } catch (error) {
    status.textContent = error.message || "Could not clear the cache.";
  }
}

async function exportXCaptures() {
  const status = document.querySelector("#xCaptureStatus");
  try {
    const response = await api.runtime.sendMessage({ type: "EXPORT_X_CAPTURES" });
    const captures = Array.isArray(response?.captures) ? response.captures : [];
    if (!captures.length) {
      status.textContent = "Nothing recorded yet. Turn on recording, save, then open some posts with AskLocal.";
      return;
    }
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), captures }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `asklocal-x-captures-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status.textContent = `Exported ${captures.length} response${captures.length === 1 ? "" : "s"}.`;
  } catch (error) {
    status.textContent = error.message || "Could not export.";
  }
}

async function clearXCaptures() {
  const status = document.querySelector("#xCaptureStatus");
  try {
    await api.runtime.sendMessage({ type: "CLEAR_X_CAPTURES" });
    status.textContent = "Cleared.";
  } catch (error) {
    status.textContent = error.message || "Could not clear.";
  }
}
