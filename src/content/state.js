import { api } from "./api.js";

export const state = {
  activePanel: null,
  activePanelMode: "asklocal",
  activeShell: null,
  shellExpanded: false,
  shellClosed: false,
  weOpenedGrok: false,
  fallbackMode: false,
  geometrySub: null,
  alignTimer: null,
  nativeCollapsePromise: null,
  // Last rect the expanded GrokDrawer actually occupied this page session.
  lastGrokRect: null,
  ignoreNativeGrokClickUntil: 0,
  switchPanelMode: null,
  settings: null,
  activeRequests: new Map(),
  lastProfileCacheAt: 0,
  lastProfileCacheKey: "",
  xVideoCandidates: [],
  xAudioCandidates: [],
  disposed: false,
  observer: null,
  mutationFrame: null,
  cleanupCallbacks: []
};

