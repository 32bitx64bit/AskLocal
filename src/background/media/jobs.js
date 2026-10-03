/**
 * Media analysis as shared background tasks.
 *
 * Every image/video analysis runs as a task keyed by the media's identity (not the
 * post), so the prefetch started when the panel opened, the ask that follows, another
 * tab asking about a repost of the same clip, and a model tool call all share one run.
 * The finished result lands in the persistent cache (media/store.js) whether or not
 * anyone is still waiting, when background completion is on.
 */

import {
  cloneJson,
  stableHash
} from "../../lib/utils.js";
import {
  runTask
} from "../orchestrator/tasks.js";
import {
  summarizeMediaTarget
} from "../tools/inspectables.js";
import {
  mediaCacheIdentity
} from "./identity.js";
import {
  analyzeImageTarget
} from "./image.js";
import {
  analyzeVideoTarget
} from "./video.js";

/** Task key: same media + same kind of analysis (automatic, or this exact focus) = same task. */
export function mediaTaskKey(target, args = {}, context = {}) {
  const kind = target?.mediaType || target?.type || "media";
  const focus = args.automatic
    ? "auto"
    : stableHash(JSON.stringify({
      prompt: String(args.prompt || "").trim(),
      question: String(context.originalQuestion || "").trim(),
      frames: args.max_frames ?? args.maxFrames ?? null,
      interval: args.frame_interval_seconds ?? args.frameIntervalSeconds ?? null
    }));
  return `media:${kind}:${mediaCacheIdentity(target)}:${focus}`;
}

/**
 * The slice of an ask's context a media analysis needs, bound to the task's own signal
 * and progress fan-out instead of the first caller's.
 */
function createTaskContext(context, signal, progress, automatic) {
  return {
    sourceTabId: context.sourceTabId ?? null,
    mediaSessionId: context.mediaSessionId || "",
    chatId: context.chatId || "",
    originalQuestion: automatic ? "" : context.originalQuestion || "",
    automaticMediaAnalysis: Boolean(automatic),
    abortSignal: signal,
    reportProgress: progress,
    mediaAnalyses: []
  };
}

/**
 * Analyze `target` (a resolved inspectable media item), joining a run already in
 * progress for the same media. Adds the result to `context.mediaAnalyses` (re-pointed
 * at this context's post) and returns it.
 *
 * options.background: keep the analysis running after this caller stops waiting
 * (defaults to settings.continueMediaInBackground).
 */
export async function analyzeMediaShared(target, args, context, settings, options = {}) {
  const kind = target?.mediaType || target?.type;
  const automatic = Boolean(args?.automatic);
  const background = options.background ?? settings.continueMediaInBackground !== false;

  const shared = await runTask(mediaTaskKey(target, args, context), {
    signal: context.abortSignal,
    background,
    onProgress: context.reportProgress ? (message) => void context.reportProgress(message) : null,
    run: ({ signal, progress }) => {
      const taskContext = createTaskContext(context, signal, progress, automatic);
      return kind === "video"
        ? analyzeVideoTarget(target, args, taskContext, settings)
        : analyzeImageTarget(target, args, taskContext, settings);
    }
  });

  // Several asks can receive the same result object; each gets its own copy, credited
  // to the post the media is on in that ask.
  const result = shared ? { ...cloneJson(shared), target: summarizeMediaTarget(target) } : shared;
  if (result) context.mediaAnalyses?.push(result);
  return result;
}
