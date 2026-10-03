import { api } from "../api.js";
import {
  buildContext,
  createAutomaticMediaRun,
  hydrateThreadAuthorProfiles,
  prepareAutomaticLinkContext,
  prepareXPostContext
} from "../ask/context.js";
import {
  resolvePerformance
} from "../orchestrator/profile.js";
import {
  configureLanes,
  describeTasks
} from "../orchestrator/tasks.js";
import {
  countMediaStore
} from "../media/store.js";
import {
  clearXCaptures,
  exportXCaptures,
  setXCaptureEnabled
} from "../x/capture.js";
import {
  ASKLOCAL_VERSION,
  CLOSED_MEDIA_SESSION_LIMIT
} from "../constants.js";
import {
  createProgressReporter,
  runWithProgressHeartbeat,
  throwIfAborted
} from "../../lib/utils.js";
import {
  CLOSED_MEDIA_SESSIONS,
  MEDIA_FRAME_CACHE,
  MEDIA_IMAGE_CACHE,
  MEDIA_SESSION_KEYS,
  clearPostMediaAnalysisCache
} from "../media/cache.js";
import {
  handleVideoCaptureProgress
} from "../media/video.js";
import {
  buildPrompt,
  buildScrubCitationMap,
  buildSystemPrompt,
  createStreamingIdScrubber,
  scrubInternalIds,
  summarizeContext
} from "../prompt/build.js";
import {
  estimateTokens,
  resolveRequestBudget
} from "../prompt/budget.js";
import {
  latestAnchorSubject,
  latestAssistantState,
  planHistoryMessages
} from "../prompt/history.js";
import {
  callProvider
} from "../providers/index.js";
import {
  buildOpenAICompatibleTools
} from "../providers/openai-compatible.js";
import {
  buildResponseSources
} from "../response/sources.js";
import {
  formatModelLabel,
  getSettings,
  openOptionsPage,
  saveSettings
} from "../settings.js";
import {
  clearChats,
  deleteChat,
  getChat,
  listChats,
  renameChat,
  upsertChat
} from "../history.js";
import {
  testProvider
} from "../test-provider.js";
import {
  exportItemAliases,
  seedItemAliases
} from "../tools/inspectables.js";
import {
  buildEvidenceDigest
} from "../tools/render.js";
import {
  cacheProfileContext
} from "../x/collect.js";
import {
  extractStatusIdFromUrl
} from "../../lib/url.js";

export const ACTIVE_ASKS = new Map();
export async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") return { ok: false, error: "Unknown message" };

  if (message.type === "ASK_LOCAL") {
    return askLocal(message.payload ?? {}, sender);
  }

  if (message.type === "CACHE_PROFILE_CONTEXT") {
    return cacheProfileContext(message.payload ?? {});
  }

  if (message.type === "PREFETCH_POST") {
    return prefetchPost(message.payload ?? {}, sender);
  }

  if (message.type === "GET_ORCHESTRATION_STATUS") {
    return { ok: true, ...describeTasks(), mediaCacheEntries: await countMediaStore() };
  }

  if (message.type === "CLEAR_MEDIA_CACHE") {
    return { ok: true, ...(await clearPostMediaAnalysisCache()) };
  }

  if (message.type === "EXPORT_X_CAPTURES") {
    return { ok: true, captures: await exportXCaptures() };
  }

  if (message.type === "CLEAR_X_CAPTURES") {
    await clearXCaptures();
    return { ok: true };
  }

  if (message.type === "CANCEL_ASK") {
    return cancelAsk(message.payload ?? {});
  }

  if (message.type === "CLEAR_MEDIA_SESSION") {
    return clearMediaSession(message.payload ?? {});
  }

  if (message.type === "ASKLOCAL_VIDEO_CAPTURE_PROGRESS") {
    return handleVideoCaptureProgress(message.payload ?? {});
  }

  if (message.type === "TEST_PROVIDER") {
    return testProvider(message.payload ?? {});
  }

  if (message.type === "GET_SETTINGS") {
    return { ok: true, version: ASKLOCAL_VERSION, settings: await getSettings() };
  }

  if (message.type === "SAVE_SETTINGS") {
    return { ok: true, version: ASKLOCAL_VERSION, settings: await saveSettings(message.payload ?? {}) };
  }

  if (message.type === "OPEN_OPTIONS") {
    await openOptionsPage();
    return { ok: true };
  }

  if (message.type === "LIST_CHATS") {
    return listChats(message.payload ?? {});
  }

  if (message.type === "GET_CHAT") {
    return getChat(message.payload ?? {});
  }

  if (message.type === "UPSERT_CHAT") {
    return upsertChat(message.payload ?? {});
  }

  if (message.type === "DELETE_CHAT") {
    return deleteChat(message.payload ?? {});
  }

  if (message.type === "CLEAR_CHATS") {
    return clearChats();
  }

  if (message.type === "RENAME_CHAT") {
    return renameChat(message.payload ?? {});
  }

  if (message.type === "OPEN_ASKLOCAL_PAGE") {
    const view = String(message.payload?.view || "chat");
    const path = view === "settings" ? "/i/asklocal?view=settings" : "/i/asklocal";
    const url = `https://x.com${path}`;
    if (api.tabs?.create) {
      // Use the X tab the user is currently looking at. Navigating an arbitrary
      // matching tab is surprising when several X windows are open.
      const tabs = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const tab = tabs?.find((candidate) => /^https:\/\/(?:x|twitter)\.com\//.test(candidate.url || ""));
      if (tab?.id != null) {
        // A live content script can show the page without asking X's router to
        // resolve our extension-owned route. Fall back to a URL navigation when
        // the tab has not finished loading or the script is unavailable.
        const shown = await api.tabs.sendMessage(tab.id, {
          type: "ASKLOCAL_SHOW_PAGE",
          payload: { view }
        }).then(() => true).catch(() => false);
        if (!shown) {
          await api.tabs.update(tab.id, { url, active: true });
        }
        return { ok: true, tabId: tab.id };
      }
      const created = await api.tabs.create({ url, active: true });
      return { ok: true, tabId: created?.id };
    }
    return { ok: false, error: "tabs API unavailable" };
  }

  return { ok: false, error: `Unsupported message: ${message.type}` };
}
export async function clearMediaSession(payload) {
  const mediaSessionId = String(payload.mediaSessionId || "").trim();
  if (!mediaSessionId) return { ok: true, removed: 0 };
  rememberClosedMediaSession(mediaSessionId);

  const keys = MEDIA_SESSION_KEYS.get(mediaSessionId);
  if (!keys) return { ok: true, removed: 0 };

  // Only raw bytes (images, frames) are session-scoped. Finished analyses stay in the
  // shared cache so a repost or a later chat about the same media is instant.
  let removed = 0;
  for (const key of keys) {
    if (MEDIA_IMAGE_CACHE.delete(key)) removed += 1;
    if (MEDIA_FRAME_CACHE.delete(key)) removed += 1;
  }
  MEDIA_SESSION_KEYS.delete(mediaSessionId);
  return { ok: true, removed };
}
/**
 * Everything the first turn about a post needs, gathered concurrently:
 *
 *   page media ─────────────┐ (starts from the page's copy of the post right away)
 *   X thread ──┬─ root/ancestor media ─┤
 *              └─ author profiles ─────┤
 *   linked articles ───────────────────┴─> prompt
 *
 * Every branch is a shared task, so work a prefetch already started is joined.
 */
export async function gatherFullContext(context, settings, progress) {
  const media = createAutomaticMediaRun(context, settings, progress);
  media.add();
  const links = prepareAutomaticLinkContext(context, settings, progress);
  const thread = (async () => {
    await prepareXPostContext(context, settings, progress);
    // The thread brings the root post, ancestors and the API's media URLs.
    media.add();
    await hydrateThreadAuthorProfiles(context, settings);
  })();
  // Media keeps running throughout; it is awaited last because the thread can still add
  // to it (only aborts reject).
  await Promise.all([thread, links]);
  await media.done();
}
/** Configure lane limits for the current settings (cheap; called per ask and prefetch). */
export function applyPerformanceSettings(settings) {
  configureLanes(resolvePerformance(settings).lanes);
  setXCaptureEnabled(settings.captureXResponses);
}
/**
 * Start reading a post in the background as soon as its panel opens, before the user
 * has typed anything: the X thread and the selected/root/quoted media. The ask that
 * follows joins these tasks instead of starting over. Results not waited for still go
 * to the caches.
 */
export async function prefetchPost(payload, sender) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.prefetchOnOpen || !payload?.tweet) return { ok: true, skipped: true };
  applyPerformanceSettings(settings);
  const context = await buildContext({ ...payload, question: "", sourceTabId: sender?.tab?.id ?? null }, settings);
  context.abortSignal = null;
  const background = { ...settings, continueMediaInBackground: true };
  // Not awaited by the panel: errors only matter to the ask that joins later.
  void (async () => {
    const media = createAutomaticMediaRun(context, background, null);
    media.add();
    try {
      await prepareXPostContext(context, settings, null);
      media.add();
      await media.done();
    } catch {
      // Best-effort.
    }
  })();
  return { ok: true, started: true };
}
export async function runAskPipeline(payload, sender, controller, progress, emitters = null) {
  const settings = await getSettings();
  if (!settings.enabled) return { disabled: true };
  applyPerformanceSettings(settings);

  await progress("Gathering visible context...");
  const context = await buildContext({
    ...payload,
    sourceTabId: sender?.tab?.id ?? null
  }, settings);
  context.abortSignal = controller.signal;
  context.reportProgress = progress;
  if (settings.streamResponses && emitters) {
    context.emitAnswerDelta = emitters.delta;
    context.emitAnswerReset = emitters.reset;
  }

  // Budget the whole request: system prompt and tool schemas are fixed overhead;
  // history and this turn's message share the rest (see prompt/budget.js).
  const budget = resolveRequestBudget(settings);
  context.requestBudget = budget;
  const overheadTokens = estimateTokens(buildSystemPrompt())
    + estimateTokens(JSON.stringify(buildOpenAICompatibleTools(settings)));
  const turnBudget = Math.max(512, budget.initialTokens - overheadTokens);

  const history = context.conversationHistory;
  const previous = latestAssistantState(history);
  // Earlier turns' ids (p3, m1, …) must keep pointing at the same items.
  seedItemAliases(context, previous.aliases);

  const question = payload.question;
  const currentSubject = String(
    context.currentTweet?.statusId
    || extractStatusIdFromUrl(context.currentTweet?.url)
    || extractStatusIdFromUrl(context.sourcePage?.url)
    || ""
  );
  const hasSubject = Boolean(context.currentTweet || currentSubject);
  const promptOptions = { previousEvidence: previous.evidence };

  // Follow-ups about the same post reuse the context already in history (the
  // "anchor" turn) instead of re-sending it. Fresh context is attached on the first
  // turn, when the post changed, or when the anchor no longer fits the budget.
  let includeFullContext = true;
  let historyPlan = planHistoryMessages([]);
  if (history.length) {
    const anchor = latestAnchorSubject(history);
    const sameSubject = !hasSubject || (anchor.found && anchor.subject === currentSubject);
    if (sameSubject) {
      const leanPrompt = buildPrompt(question, context, settings, {
        ...promptOptions,
        includeFullContext: false,
        budgetTokens: Math.floor(turnBudget * 0.5)
      });
      historyPlan = planHistoryMessages(history, { budgetTokens: turnBudget - estimateTokens(leanPrompt) });
      includeFullContext = hasSubject && !historyPlan.anchorKept;
    }
    if (includeFullContext) {
      historyPlan = planHistoryMessages(history, { budgetTokens: Math.floor(turnBudget * 0.45) });
    }
  }

  if (includeFullContext) {
    await gatherFullContext(context, settings, progress);
    throwIfAborted(controller.signal);
  } else {
    context.reusedConversationContext = historyPlan.anchorKept;
    if (hasSubject) {
      // The thread is already in history; this (cached) read only makes ids for its
      // posts and media resolvable again for tools.
      await prepareXPostContext(context, settings, progress);
      throwIfAborted(controller.signal);
    }
  }

  await progress("Preparing prompt...");
  const promptBudget = Math.max(512, turnBudget - historyPlan.tokens);
  const turnPromptOptions = { ...promptOptions, includeFullContext, budgetTokens: promptBudget };
  const prompt = buildPrompt(question, context, settings, turnPromptOptions);
  context.historyMessages = historyPlan.messages;
  let shrinkBudget = promptBudget;
  context.shrinkPrompt = () => {
    shrinkBudget = Math.floor(shrinkBudget * 0.6);
    if (shrinkBudget < 256) return "";
    const smaller = buildPrompt(question, context, settings, { ...turnPromptOptions, budgetTokens: shrinkBudget });
    return estimateTokens(smaller) < estimateTokens(context.sentPrompt || prompt) ? smaller : "";
  };

  // Tool calls add items (and ids) mid-answer, so rebuild the map on a miss.
  let scrubMap = buildScrubCitationMap(context);
  const citationMap = {
    get: (id) => scrubMap.get(id) ?? (scrubMap = buildScrubCitationMap(context)).get(id)
  };
  let flushAnswerScrubber = null;
  if (typeof context.emitAnswerDelta === "function") {
    const emitRawDelta = context.emitAnswerDelta;
    const scrubber = createStreamingIdScrubber(emitRawDelta, citationMap);
    context.emitAnswerDelta = (chunk) => scrubber.push(chunk);
    flushAnswerScrubber = () => scrubber.flush();
  }
  // Streaming already keeps the Port busy with deltas. Non-streaming generations
  // (and slow first tokens) need an explicit pulse so the worker is not idled out.
  const answer = settings.streamResponses && emitters
    ? await callProvider(settings, prompt, context, progress)
    : await runWithProgressHeartbeat(
      () => callProvider(settings, prompt, context, progress),
      {
        reportProgress: progress,
        label: (seconds) => (seconds ? `Waiting on the model — ${seconds}s...` : "Waiting on the model..."),
        heartbeatMs: 10_000,
        signal: controller.signal
      }
    );
  flushAnswerScrubber?.();

  const carriesContext = includeFullContext && hasSubject;
  return {
    answer: scrubInternalIds(answer, citationMap).trim(),
    model: formatModelLabel(settings, { includeApiId: true }),
    contextSummary: summarizeContext(context),
    // Stored by the panel on this turn's chat entries and sent back with the next ask
    // (see prompt/history.js for the layout).
    turn: {
      context: context.sentPrompt || prompt,
      contextKind: carriesContext ? "full" : "followup",
      subject: carriesContext ? currentSubject : "",
      evidence: buildEvidenceDigest(context.toolEvidence, budget.evidenceChars),
      aliases: exportItemAliases(context)
    },
    context
  };
}
export async function askLocal(payload, sender) {
  const progress = createProgressReporter(sender, payload.requestId);
  const requestId = String(payload.requestId || "").trim();
  const controller = new AbortController();
  if (requestId) ACTIVE_ASKS.set(requestId, controller);

  try {
    const result = await runAskPipeline(payload, sender, controller, progress);
    if (result.disabled) return { ok: false, error: "AskLocal is disabled." };
    await progress("Loading source icons...");
    const sources = await buildResponseSources(result.context);
    await progress("Finalizing answer...");

    return {
      ok: true,
      answer: result.answer,
      model: result.model,
      contextSummary: result.contextSummary,
      turn: result.turn,
      sources
    };
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      return { ok: false, stopped: true, error: "Stopped." };
    }
    throw error;
  } finally {
    if (requestId) ACTIVE_ASKS.delete(requestId);
  }
}
export async function cancelAsk(payload) {
  const requestId = String(payload.requestId || "").trim();
  const controller = requestId ? ACTIVE_ASKS.get(requestId) : null;
  if (!controller) return { ok: true, cancelled: false };
  controller.abort();
  return { ok: true, cancelled: true };
}
export function rememberClosedMediaSession(mediaSessionId) {
  const id = String(mediaSessionId || "").trim();
  if (!id) return;
  CLOSED_MEDIA_SESSIONS.delete(id);
  CLOSED_MEDIA_SESSIONS.add(id);
  while (CLOSED_MEDIA_SESSIONS.size > CLOSED_MEDIA_SESSION_LIMIT) {
    CLOSED_MEDIA_SESSIONS.delete(CLOSED_MEDIA_SESSIONS.values().next().value);
  }
}

