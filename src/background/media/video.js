import { api } from "../api.js";
import {
  AUDIO_ANALYSIS_STRATEGY,
  AV_ANALYSIS_MERGE_STRATEGY,
  DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  DEFAULT_VIDEO_CHUNK_SECONDS,
  DONT_RETRY_HINT,
  MAX_VIDEO_CHUNK_CONCURRENCY,
  MAX_VIDEO_CHUNK_SECONDS,
  MEDIA_ANALYSIS_CARRY_FORWARD_CHARS,
  MEDIA_ANALYSIS_CHUNK_HEARTBEAT_MS,
  MEDIA_ANALYSIS_CHUNK_TIMEOUT_MS,
  MEDIA_CACHE_PREFIX,
  MEDIA_FRAME_CACHE_LIMIT,
  MIN_VIDEO_CHUNK_CONCURRENCY,
  MIN_VIDEO_CHUNK_SECONDS,
  MIN_VIDEO_FRAME_INTERVAL_SECONDS,
  VIDEO_ANALYSIS_STRATEGY,
  VIDEO_ANALYSIS_SYSTEM_PROMPT,
  VIDEO_FRAME_HASH_MAX_DISTANCE,
  VIDEO_FRAME_HASH_SIZE,
  VIDEO_FRAME_MAX_GAP_SECONDS,
  VIDEO_FRAME_MAX_SIDE
} from "../constants.js";
import {
  extractStatusIdFromUrl,
  isRawTweetAudioFileUrl,
  isRawTweetVideoFileUrl,
  normalizeRawAudioUrls,
  normalizeSourceUrl
} from "../../lib/url.js";
import {
  clampNumber,
  formatSeconds,
  sleep,
  stableHash,
  throwIfAborted
} from "../../lib/utils.js";
import {
  analyzeVideoAudioSafely,
  buildAudioAnalysisPrompt,
  callAudioChunkAnalysis,
  compactAudioCarryForward,
  normalizeAudioChunks
} from "../media/audio.js";
import {
  MEDIA_FRAME_CACHE,
  VIDEO_CAPTURE_PROGRESS_HANDLERS,
  buildMediaAnalysisCacheKey,
  buildPostMediaAnalysisCacheKey,
  canPersistPostMediaAnalysis,
  findExistingMediaAnalysis,
  mediaCacheFingerprint,
  readCachedMediaAnalysis,
  readPostMediaAnalysis,
  rememberLimitedCache,
  writeCachedMediaAnalysis,
  writePostMediaAnalysis
} from "../media/cache.js";
import {
  callMediaAnalysisProvider,
  formatMediaPostContext,
  normalizeAnalysisImage,
  resolveMediaProviderSettings
} from "../media/image.js";
import {
  createStreamingAnalysisPool,
  sectionsFromPoolResults
} from "../media/pipeline.js";
import {
  createDualAvMapProgress,
  createMediaChunkPoolProgress
} from "../media/progress.js";
import {
  isFatalMediaProviderError
} from "../providers/errors.js";
import {
  buildInspectableItems,
  compactMediaRef,
  resolveInspectableMediaTarget,
  summarizeMediaTarget
} from "../tools/inspectables.js";

export async function analyzeVideoTool(args, context, settings) {
  if (!settings.allowVideoAnalysis) {
    return { ok: false, tool: "analyze_video", error: "Video analysis is disabled in AskLocal settings." };
  }

  const target = resolveInspectableMediaTarget(args, context, "video");
  if (!target) {
    const available = buildInspectableItems(context);
    return {
      ok: false,
      tool: "analyze_video",
      error: `Could not resolve the requested video. ${DONT_RETRY_HINT}`,
      availableVideos: available.media.filter((item) => item.mediaType === "video").slice(0, 12).map(compactMediaRef)
    };
  }

  const existing = findExistingMediaAnalysis(context, target, "video");
  if (existing) return compactReusedVideoToolResult(existing);

  const maxFrames = Math.floor(clampNumber(args.max_frames ?? args.maxFrames ?? settings.maxVideoFrames, 0, Infinity, settings.maxVideoFrames));
  const frameIntervalSeconds = clampNumber(
    args.frame_interval_seconds ?? args.frameIntervalSeconds ?? settings.videoFrameIntervalSeconds,
    MIN_VIDEO_FRAME_INTERVAL_SECONDS,
    30,
    settings.videoFrameIntervalSeconds
  );
  const framesPerMinute = Math.floor(clampNumber(args.frames_per_minute ?? args.framesPerMinute ?? settings.videoFramesPerMinute, 0, Infinity, settings.videoFramesPerMinute));
  const chunkSeconds = clampNumber(
    args.chunk_seconds ?? args.chunkSeconds ?? settings.videoChunkSeconds,
    MIN_VIDEO_CHUNK_SECONDS,
    MAX_VIDEO_CHUNK_SECONDS,
    settings.videoChunkSeconds
  );
  const chunkConcurrency = Math.floor(clampNumber(
    args.chunk_concurrency ?? args.chunkConcurrency ?? settings.videoChunkConcurrency,
    MIN_VIDEO_CHUNK_CONCURRENCY,
    MAX_VIDEO_CHUNK_CONCURRENCY,
    settings.videoChunkConcurrency ?? DEFAULT_VIDEO_CHUNK_CONCURRENCY
  ));
  const subtitleCoverageSolid = hasSolidSubtitleCoverage(target);
  const includeAudio = Boolean(settings.allowAudioAnalysis) && !subtitleCoverageSolid;
  const providerSettings = resolveMediaProviderSettings(settings, "video");
  const mergeProviderSettings = resolveMediaProviderSettings(settings, "videoMerge");
  const audioProviderSettings = includeAudio ? resolveMediaProviderSettings(settings, "audio") : null;
  const cacheExtra = {
    maxFrames,
    frameIntervalSeconds,
    framesPerMinute,
    chunkSeconds,
    videoAnalysisStrategy: VIDEO_ANALYSIS_STRATEGY,
    mergeModel: `${mergeProviderSettings.provider}:${mergeProviderSettings.model}`,
    includeAudio,
    audioAnalysisStrategy: includeAudio ? AUDIO_ANALYSIS_STRATEGY : "",
    avMergeStrategy: includeAudio ? AV_ANALYSIS_MERGE_STRATEGY : "",
    audioModel: includeAudio && audioProviderSettings
      ? `${audioProviderSettings.provider}:${audioProviderSettings.model}`
      : ""
  };
  const cacheKey = buildMediaAnalysisCacheKey("video", target, context, args, providerSettings, cacheExtra);
  const postCacheKey = canPersistPostMediaAnalysis(target)
    ? buildPostMediaAnalysisCacheKey("video", target, context, args, providerSettings, cacheExtra)
    : "";

  const cached = await readCachedMediaAnalysis(cacheKey);
  if (cached) {
    context.mediaAnalyses.push(cached);
    return cached;
  }

  if (postCacheKey) {
    const postCached = await readPostMediaAnalysis(postCacheKey);
    if (postCached) {
      // Also warm the session cache so same-session follow-ups stay local.
      await writeCachedMediaAnalysis(cacheKey, {
        ...postCached,
        cached: false,
        reusedFromPost: false
      }, context.mediaSessionId);
      context.mediaAnalyses.push(postCached);
      return postCached;
    }
  }

  return runPipelinedVideoAudioAnalysis({
    args,
    target,
    context,
    settings,
    maxFrames,
    frameIntervalSeconds,
    framesPerMinute,
    chunkSeconds,
    chunkConcurrency,
    includeAudio,
    subtitleCoverageSolid,
    providerSettings,
    mergeProviderSettings,
    audioProviderSettings,
    cacheKey,
    postCacheKey
  });
}

/**
 * Capture frames/audio and start LLM windows as soon as each chunk is ready,
 * overlapping later capture with earlier vision/transcription (concurrency-limited).
 */
export async function runPipelinedVideoAudioAnalysis({
  args,
  target,
  context,
  settings,
  maxFrames,
  frameIntervalSeconds,
  framesPerMinute,
  chunkSeconds,
  chunkConcurrency,
  includeAudio,
  subtitleCoverageSolid,
  providerSettings,
  mergeProviderSettings,
  audioProviderSettings,
  cacheKey,
  postCacheKey
}) {
  const concurrency = Math.floor(clampNumber(
    chunkConcurrency,
    MIN_VIDEO_CHUNK_CONCURRENCY,
    MAX_VIDEO_CHUNK_CONCURRENCY,
    DEFAULT_VIDEO_CHUNK_CONCURRENCY
  ));
  const ordered = concurrency <= 1;
  const includeQuestion = !args.automatic;
  const requestPrompt = args.prompt;

  const avProgress = includeAudio
    ? createDualAvMapProgress(context.reportProgress, { videoTotal: 0, audioTotal: 0 })
    : null;
  const videoProgress = avProgress?.video || createMediaChunkPoolProgress(context.reportProgress, {
    kind: "video",
    total: 0
  });
  const audioProgress = avProgress?.audio || null;

  await context.reportProgress?.(
    includeAudio
      ? "Capturing media and starting analysis as windows are ready..."
      : "Capturing video and starting analysis as windows are ready..."
  );

  const videoPool = createStreamingAnalysisPool({
    concurrency,
    ordered,
    signal: context.abortSignal,
    progress: videoProgress,
    updateCarry: ordered
      ? (_prev, result, item) => ({
        rangeLabel: item.rangeLabel || result.rangeLabel || "",
        summary: result.ok
          ? compactPreviousWindowNotes(result.section)
          : `(Previous window ${item.rangeLabel || ""} failed analysis; continue from visible frames alone.)`
      })
      : null,
    analyze: async (item) => {
      const frames = Array.isArray(item.frames) ? item.frames : [];
      if (!frames.length) {
        return { error: "No frames in this video window." };
      }
      const totalHint = Math.max(item.estimatedTotal || 0, item.index + 1, videoPool.size || 1);
      const prompt = buildVideoAnalysisPrompt(requestPrompt, target, context, frames, {
        includeQuestion,
        chunk: {
          position: item.index + 1,
          total: totalHint,
          rangeLabel: item.rangeLabel,
          startSeconds: item.startSeconds,
          endSeconds: item.endSeconds,
          previousSummary: item.previousCarry || null,
          mode: ordered ? "sequential" : "parallel"
        }
      });
      const section = await callVideoChunkAnalysis(providerSettings, {
        kind: "video",
        prompt,
        images: frames,
        target,
        signal: context.abortSignal
      }, {
        label: `video window ${item.index + 1}`,
        rangeLabel: item.rangeLabel,
        onHeartbeat: videoProgress.bindHeartbeat?.() || null,
        reportProgress: ordered ? context.reportProgress : null
      });
      return { section };
    }
  });

  const audioPool = includeAudio
    ? createStreamingAnalysisPool({
      concurrency,
      ordered,
      signal: context.abortSignal,
      progress: audioProgress,
      updateCarry: ordered
        ? (_prev, result, item) => ({
          rangeLabel: item.rangeLabel || result.rangeLabel || "",
          summary: result.ok
            ? compactAudioCarryForward(result.section)
            : `(Previous audio window ${item.rangeLabel || ""} failed; continue from audible audio alone.)`
        })
        : null,
      analyze: async (item) => {
        const chunks = normalizeAudioChunks([item.chunk || item]);
        if (!chunks.length) return { error: "No usable audio in this window." };
        const chunk = chunks[0];
        const totalHint = Math.max(item.estimatedTotal || 0, item.index + 1, audioPool.size || 1);
        const prompt = buildAudioAnalysisPrompt(requestPrompt, target, context, chunk, {
          includeQuestion: true,
          chunk: {
            position: item.index + 1,
            total: totalHint,
            rangeLabel: chunk.rangeLabel || item.rangeLabel,
            previousSummary: item.previousCarry || null,
            mode: ordered ? "sequential" : "parallel"
          }
        });
        const section = await callAudioChunkAnalysis(audioProviderSettings, {
          kind: "audio",
          prompt,
          audioChunks: [chunk],
          target,
          signal: context.abortSignal
        }, {
          label: `audio window ${item.index + 1}`,
          rangeLabel: chunk.rangeLabel || item.rangeLabel,
          onHeartbeat: audioProgress?.bindHeartbeat?.() || null,
          reportProgress: ordered ? context.reportProgress : null
        });
        return { section };
      }
    })
    : null;

  const seenVideoWindows = new Set();
  const seenAudioChunks = new Set();

  const enqueueVideoWindow = (window) => {
    if (!window) return;
    const index = Math.max(0, Math.floor(Number(window.index) || 0));
    if (seenVideoWindows.has(index)) return;
    const frames = (Array.isArray(window.frames) ? window.frames : [])
      .map((frame) => normalizeAnalysisImage(frame))
      .filter((frame) => frame?.ok);
    if (!frames.length) return;
    seenVideoWindows.add(index);
    videoPool.enqueue({
      kind: "video",
      index,
      frames,
      startSeconds: window.startSeconds,
      endSeconds: window.endSeconds,
      rangeLabel: window.rangeLabel || `${formatSeconds(window.startSeconds)}-${formatSeconds(window.endSeconds)}`,
      estimatedTotal: window.estimatedTotal
    });
  };

  const enqueueAudioChunk = (chunk) => {
    if (!audioPool || !chunk) return;
    const index = Math.max(0, Math.floor(Number(chunk.index) || 0));
    if (seenAudioChunks.has(index)) return;
    const normalized = normalizeAudioChunks([chunk]);
    if (!normalized.length) return;
    seenAudioChunks.add(index);
    audioPool.enqueue({
      kind: "audio",
      index,
      chunk: normalized[0],
      startSeconds: normalized[0].startSeconds,
      endSeconds: normalized[0].endSeconds,
      rangeLabel: normalized[0].rangeLabel,
      estimatedTotal: chunk.estimatedTotal
    });
  };

  let capture;
  try {
    capture = await collectVideoAnalysisFramesOnce(target, context, maxFrames, frameIntervalSeconds, framesPerMinute, {
      includeAudio,
      chunkSeconds,
      audioUrls: getTargetRawAudioUrls(target),
      streamWindows: true,
      onVideoWindow: enqueueVideoWindow,
      onAudioChunk: enqueueAudioChunk,
      onCaptureMeta: (detail) => {
        if (detail?.estimatedVideoWindows) videoProgress.setTotal?.(detail.estimatedVideoWindows);
        if (detail?.totalAudioChunks) audioProgress?.setTotal?.(detail.totalAudioChunks);
      }
    });
  } catch (error) {
    videoPool.fail(error);
    audioPool?.fail(error);
    throw error;
  } finally {
    avProgress?.setCapturing?.(false);
  }

  const frames = Array.isArray(capture) ? capture : capture.frames;
  const audioChunks = Array.isArray(capture?.audioChunks) ? capture.audioChunks : [];
  let audioError = String(capture.audioError || "");
  if (!includeAudio && settings.allowAudioAnalysis && subtitleCoverageSolid) {
    audioError = "";
  }

  // Fallback / completion: enqueue anything not already streamed (tab capture, cache, etc.).
  if (frames?.length) {
    for (const [index, chunk] of groupVideoFramesIntoChunks(frames, chunkSeconds).entries()) {
      enqueueVideoWindow({
        index,
        frames: chunk.frames,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        rangeLabel: chunk.rangeLabel,
        estimatedTotal: Math.max(seenVideoWindows.size, index + 1)
      });
    }
  }
  if (includeAudio && audioChunks.length) {
    for (const [index, chunk] of normalizeAudioChunks(audioChunks).entries()) {
      enqueueAudioChunk({ ...chunk, index, estimatedTotal: audioChunks.length });
    }
  }

  videoPool.close();
  audioPool?.close();

  if (!frames?.length && !target.videoSubtitles?.length && !seenVideoWindows.size && !seenAudioChunks.size) {
    return {
      ok: false,
      tool: "analyze_video",
      target: summarizeMediaTarget(target),
      rawVideoUrl: capture.rawVideoUrl || "",
      error: capture.error || "Could not resolve a raw X video URL or capture readable frames from it."
    };
  }

  let videoPoolResult = { results: new Map(), failedChunkCount: 0, chunkCount: 0 };
  let audioPoolResult = null;
  try {
    const waits = [videoPool.done];
    if (audioPool) waits.push(audioPool.done);
    const settled = await Promise.all(waits);
    videoPoolResult = settled[0];
    audioPoolResult = audioPool ? settled[1] : null;
  } catch (error) {
    if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
    if (isFatalMediaProviderError(error)) {
      throw new Error(
        `${error.message} Lower Max sampled video frames / raise the frame interval in AskLocal settings, or use a sturdier vision model.`
      );
    }
    throw error;
  }

  // No streamed/batched windows — fall back to the classic one-shot analyzer
  // (single-window clips, subtitle-only, or tab-capture edge cases).
  if (!videoPoolResult.chunkCount && !audioPoolResult?.chunkCount) {
    if ((frames && frames.length) || target.videoSubtitles?.length) {
      const analysisRun = await runVideoAnalysis({
        requestPrompt,
        target,
        context,
        frames: frames || [],
        chunkSeconds,
        chunkConcurrency: concurrency,
        includeQuestion,
        providerSettings,
        mergeProviderSettings
      });
      let audioRun = null;
      if (includeAudio && audioChunks.length) {
        audioRun = await analyzeVideoAudioSafely({
          audioChunks,
          target,
          context,
          requestPrompt,
          chunkConcurrency: concurrency,
          providerSettings: audioProviderSettings,
          mergeProviderSettings,
          deferMerge: false
        });
        if (!audioRun.ok && audioRun.audioError) audioError = audioRun.audioError;
      }
      return finalizeVideoAnalysisResult({
        target,
        context,
        providerSettings,
        mergeProviderSettings,
        audioProviderSettings,
        frames: frames || [],
        frameIntervalSeconds,
        chunkSeconds,
        chunkConcurrency: concurrency,
        capture,
        analysisRun,
        audioRun,
        audioError,
        cacheKey,
        postCacheKey
      });
    }
    return {
      ok: false,
      tool: "analyze_video",
      target: summarizeMediaTarget(target),
      rawVideoUrl: capture.rawVideoUrl || "",
      error: capture.error || "Video analysis returned no windows."
    };
  }

  const videoSections = sectionsFromPoolResults(videoPoolResult.results, {
    labelPrefix: "Window",
    failurePrefix: "Analysis failed for this window"
  });
  const audioSections = audioPoolResult
    ? sectionsFromPoolResults(audioPoolResult.results, {
      labelPrefix: "Audio window",
      failurePrefix: "Analysis failed for this window"
    })
    : [];

  let analysisRun = {
    analysis: videoSections.length
      ? stitchWindowSections(
        videoSections,
        videoPoolResult.chunkCount,
        chunkSeconds,
        videoPoolResult.failedChunkCount,
        { mergeFailed: false }
      )
      : "",
    sections: videoSections.map((section) => {
      const rangeMatch = section.match(/=== Window \d+ of \d+ \(([^)]+)\) ===/);
      const rangeLabel = rangeMatch?.[1] || "";
      return rangeLabel
        ? `=== Window (${rangeLabel}) ===\n${compactWindowNotesForMerge(section)}`
        : compactWindowNotesForMerge(section);
    }),
    chunkCount: videoPoolResult.chunkCount,
    failedChunkCount: videoPoolResult.failedChunkCount,
    avMerged: false
  };

  let audioRun = null;
  if (includeAudio) {
    if (audioSections.length) {
      audioRun = {
        ok: true,
        audioAnalysis: audioSections.join("\n\n"),
        sections: audioSections.map((section) => compactWindowNotesForMerge(section)),
        audioChunkCount: audioPoolResult.chunkCount,
        failedChunkCount: audioPoolResult.failedChunkCount || 0,
        audioError: ""
      };
    } else {
      audioRun = {
        ok: false,
        audioAnalysis: "",
        sections: [],
        audioChunkCount: audioChunks.length,
        failedChunkCount: 0,
        audioError: audioError || "No audio chunks were analyzed."
      };
    }
  }

  const shouldMergeAv = includeAudio && audioSections.length > 0 && videoSections.length > 0;
  if (shouldMergeAv) {
    await context.reportProgress?.("Merging video and audio analyses...");
    try {
      const merged = await mergeAudioVideoAnalysis({
        requestPrompt,
        target,
        context,
        includeQuestion,
        chunkSeconds,
        videoSections: analysisRun.sections,
        audioSections: audioRun.sections,
        videoChunkCount: analysisRun.chunkCount,
        audioChunkCount: audioRun.audioChunkCount || audioSections.length,
        videoFailedChunkCount: analysisRun.failedChunkCount || 0,
        audioFailedChunkCount: audioRun.failedChunkCount || 0,
        mergeProviderSettings
      });
      analysisRun = {
        ...analysisRun,
        analysis: merged.analysis,
        avMerged: true
      };
    } catch (error) {
      if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
      // Keep stitched video + separate audio on merge failure.
    }
  } else if (!videoSections.length && audioSections.length) {
    analysisRun = {
      ...analysisRun,
      analysis: audioSections.join("\n\n"),
      avMerged: false
    };
  } else if (!ordered && videoSections.length > 1) {
    // Parallel map: optional text merge of video windows when AV merge is not used.
    await context.reportProgress?.("Merging video window analyses...");
    try {
      const mergePrompt = buildVideoMergePrompt({
        requestPrompt,
        target,
        context,
        includeQuestion,
        chunkSeconds,
        sections: analysisRun.sections,
        chunkCount: analysisRun.chunkCount,
        failedChunkCount: analysisRun.failedChunkCount
      });
      const merged = await callVideoChunkAnalysis(mergeProviderSettings || providerSettings, {
        kind: "video",
        prompt: mergePrompt,
        images: [],
        target,
        signal: context.abortSignal
      }, {
        label: "video merge",
        reportProgress: context.reportProgress
      });
      const mergeLabel = `${(mergeProviderSettings || providerSettings).provider}:${(mergeProviderSettings || providerSettings).model}`;
      const header = [
        `Combined video analysis merged from ${analysisRun.chunkCount} consecutive ~${chunkSeconds}s windows (pipelined map-reduce; merge model ${mergeLabel}).`,
        analysisRun.failedChunkCount
          ? `${analysisRun.failedChunkCount} window${analysisRun.failedChunkCount === 1 ? "" : "s"} failed during mapping and were noted; remaining windows still contain visual evidence.`
          : "Each window was analyzed as soon as its frames were captured, then a text-only merge unified recurring people/objects across the timeline.",
        "All timestamps are absolute clip time."
      ].join(" ");
      analysisRun = {
        ...analysisRun,
        analysis: [header, "", String(merged || "").trim()].filter(Boolean).join("\n")
      };
    } catch (error) {
      if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
      // Keep stitched windows.
    }
  }

  return finalizeVideoAnalysisResult({
    target,
    context,
    providerSettings,
    mergeProviderSettings,
    audioProviderSettings,
    frames: frames || [],
    frameIntervalSeconds,
    chunkSeconds,
    chunkConcurrency: concurrency,
    capture,
    analysisRun,
    audioRun,
    audioError,
    cacheKey,
    postCacheKey
  });
}

async function finalizeVideoAnalysisResult({
  target,
  context,
  providerSettings,
  mergeProviderSettings,
  audioProviderSettings,
  frames,
  frameIntervalSeconds,
  chunkSeconds,
  chunkConcurrency,
  capture,
  analysisRun,
  audioRun,
  audioError,
  cacheKey,
  postCacheKey
}) {
  const audioIncluded = Boolean(
    analysisRun.avMerged
    || (audioRun?.ok && (audioRun.audioAnalysis || audioRun.sections?.length))
  );
  const result = {
    ok: true,
    tool: "analyze_video",
    type: "video",
    target: summarizeMediaTarget(target),
    model: `${providerSettings.provider}:${providerSettings.model}`,
    mergeModel: `${mergeProviderSettings.provider}:${mergeProviderSettings.model}`,
    frameCount: frames.length,
    frameIntervalSeconds,
    chunkSeconds,
    chunkConcurrency,
    chunkCount: analysisRun.chunkCount,
    failedChunkCount: analysisRun.failedChunkCount || 0,
    rawVideoUrl: capture.rawVideoUrl || "",
    subtitleSourceCount: target.videoSubtitles?.length ?? 0,
    analysis: analysisRun.analysis,
    audioAnalysis: analysisRun.avMerged ? "" : (audioRun?.audioAnalysis || ""),
    audioChunkCount: audioRun?.audioChunkCount || 0,
    audioModel: audioProviderSettings
      ? `${audioProviderSettings.provider}:${audioProviderSettings.model}`
      : "",
    audioMergedIntoAnalysis: Boolean(analysisRun.avMerged),
    audioError: audioIncluded ? "" : audioError,
    pipelined: true
  };
  await writeCachedMediaAnalysis(cacheKey, result, context.mediaSessionId);
  if (postCacheKey) {
    await writePostMediaAnalysis(postCacheKey, result, {
      sourceChatId: context.chatId || "",
      target
    });
  }
  context.mediaAnalyses.push(result);
  return result;
}
export async function runVideoAnalysis({
  requestPrompt,
  target,
  context,
  frames,
  chunkSeconds,
  chunkConcurrency = DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  includeQuestion,
  providerSettings,
  mergeProviderSettings = null,
  deferMerge = false,
  poolProgress = null
}) {
  const chunks = groupVideoFramesIntoChunks(frames, chunkSeconds);
  if (chunks.length <= 1) {
    poolProgress?.start?.();
    try {
      const prompt = buildVideoAnalysisPrompt(requestPrompt, target, context, frames, { includeQuestion });
      const analysis = await callVideoChunkAnalysis(providerSettings, {
        kind: "video",
        prompt,
        images: frames,
        target,
        signal: context.abortSignal
      }, {
        label: "video",
        reportProgress: context.reportProgress,
        onHeartbeat: poolProgress?.bindHeartbeat?.() || null
      });
      return {
        analysis,
        sections: analysis ? [`=== Window 1 of 1 ===\n${analysis}`] : [],
        chunkCount: 1,
        failedChunkCount: 0
      };
    } finally {
      poolProgress?.finish?.();
    }
  }

  const concurrency = Math.floor(clampNumber(
    chunkConcurrency,
    MIN_VIDEO_CHUNK_CONCURRENCY,
    MAX_VIDEO_CHUNK_CONCURRENCY,
    DEFAULT_VIDEO_CHUNK_CONCURRENCY
  ));

  // Concurrency 1: sequential carry-forward (no redundant merge pass).
  // Concurrency > 1: independent parallel maps; merge unless deferred for AV combine.
  if (concurrency <= 1) {
    return runSequentialCarryForwardAnalysis({
      requestPrompt,
      target,
      context,
      chunks,
      chunkSeconds,
      includeQuestion,
      providerSettings,
      poolProgress
    });
  }

  return runParallelMapReduceAnalysis({
    requestPrompt,
    target,
    context,
    chunks,
    chunkSeconds,
    concurrency,
    includeQuestion,
    providerSettings,
    mergeProviderSettings: mergeProviderSettings || providerSettings,
    deferMerge,
    poolProgress
  });
}

async function runSequentialCarryForwardAnalysis({
  requestPrompt,
  target,
  context,
  chunks,
  chunkSeconds,
  includeQuestion,
  providerSettings,
  poolProgress = null
}) {
  let previousSummary = null;
  const sectionTexts = [];
  let failedChunkCount = 0;

  for (const [position, chunk] of chunks.entries()) {
    throwIfAborted(context.abortSignal);
    const label = `video chunk ${position + 1} of ${chunks.length}`;
    poolProgress?.start?.();
    if (!poolProgress) {
      await context.reportProgress?.(`Analyzing ${label} (${chunk.rangeLabel})...`);
    }
    const prompt = buildVideoAnalysisPrompt(requestPrompt, target, context, chunk.frames, {
      includeQuestion,
      chunk: {
        position: position + 1,
        total: chunks.length,
        rangeLabel: chunk.rangeLabel,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        previousSummary,
        mode: "sequential"
      }
    });
    try {
      const section = await callVideoChunkAnalysis(providerSettings, {
        kind: "video",
        prompt,
        images: chunk.frames,
        target,
        signal: context.abortSignal
      }, {
        label,
        rangeLabel: chunk.rangeLabel,
        reportProgress: context.reportProgress,
        onHeartbeat: poolProgress?.bindHeartbeat?.() || null
      });
      previousSummary = {
        rangeLabel: chunk.rangeLabel,
        summary: compactPreviousWindowNotes(section)
      };
      sectionTexts.push(`=== Window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n${section}`);
    } catch (error) {
      if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
      if (isFatalMediaProviderError(error)) {
        throw new Error(
          `${error.message} Lower Max sampled video frames / raise the frame interval in AskLocal settings, or use a sturdier vision model.`
        );
      }
      failedChunkCount += 1;
      const reason = String(error?.message || "Video chunk analysis failed.").slice(0, 240);
      sectionTexts.push(
        `=== Window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n[Analysis failed for this window: ${reason}]`
      );
      previousSummary = {
        rangeLabel: chunk.rangeLabel,
        summary: `(Previous window ${chunk.rangeLabel} failed analysis; continue from visible frames alone.)`
      };
      if (poolProgress?.note) {
        poolProgress.note(`Video ${label} failed (${reason}). Continuing with remaining chunks...`);
      } else {
        await context.reportProgress?.(
          `Video ${label} failed (${reason}). Continuing with remaining chunks...`
        );
      }
    } finally {
      poolProgress?.finish?.();
    }
  }

  if (!sectionTexts.length || failedChunkCount >= chunks.length) {
    throw new Error(
      failedChunkCount
        ? `Video analysis failed for all ${chunks.length} windows.`
        : "Video analysis returned no windows."
    );
  }

  const header = [
    `Combined video analysis stitched from ${chunks.length} consecutive ~${chunkSeconds}s windows.`,
    failedChunkCount
      ? `${failedChunkCount} window${failedChunkCount === 1 ? "" : "s"} failed and were marked in place; remaining windows still contain visual evidence.`
      : "Windows were analyzed in order and each analyst saw compact continuity notes from the previous window, so recurring people/objects may only be fully described where they first appear.",
    "All timestamps are absolute clip time."
  ].join(" ");
  return {
    analysis: [header, "", sectionTexts.join("\n\n")].join("\n"),
    sections: sectionTexts.slice(),
    chunkCount: chunks.length,
    failedChunkCount
  };
}

async function runParallelMapReduceAnalysis({
  requestPrompt,
  target,
  context,
  chunks,
  chunkSeconds,
  concurrency,
  includeQuestion,
  providerSettings,
  mergeProviderSettings,
  deferMerge = false,
  poolProgress = null
}) {
  const sectionTexts = new Array(chunks.length);
  let failedChunkCount = 0;
  let fatalError = null;
  const poolController = new AbortController();
  const onParentAbort = () => poolController.abort();
  if (context.abortSignal?.aborted) throw new DOMException("The request was stopped.", "AbortError");
  context.abortSignal?.addEventListener?.("abort", onParentAbort, { once: true });

  const progress = poolProgress || createMediaChunkPoolProgress(context.reportProgress, {
    kind: "video",
    total: chunks.length
  });

  try {
    await runWithConcurrency(chunks.length, concurrency, async (position) => {
      throwIfAborted(context.abortSignal);
      if (fatalError || poolController.signal.aborted) {
        throw fatalError || new DOMException("The request was stopped.", "AbortError");
      }

      const chunk = chunks[position];
      const label = `video window ${position + 1}/${chunks.length}`;
      progress.start();
      const prompt = buildVideoAnalysisPrompt(requestPrompt, target, context, chunk.frames, {
        includeQuestion,
        chunk: {
          position: position + 1,
          total: chunks.length,
          rangeLabel: chunk.rangeLabel,
          startSeconds: chunk.startSeconds,
          endSeconds: chunk.endSeconds,
          mode: "parallel"
        }
      });

      try {
        const section = await callVideoChunkAnalysis(providerSettings, {
          kind: "video",
          prompt,
          images: chunk.frames,
          target,
          signal: poolController.signal
        }, {
          label,
          rangeLabel: chunk.rangeLabel,
          onHeartbeat: progress.bindHeartbeat()
        });
        sectionTexts[position] = `=== Window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n${section}`;
      } catch (error) {
        if (fatalError) throw fatalError;
        if (error?.name === "AbortError" || context.abortSignal?.aborted || poolController.signal.aborted) {
          throw error;
        }
        if (isFatalMediaProviderError(error)) {
          fatalError = new Error(
            `${error.message} Lower Max sampled video frames / raise the frame interval in AskLocal settings, or use a sturdier vision model.`
          );
          poolController.abort();
          throw fatalError;
        }
        failedChunkCount += 1;
        const reason = String(error?.message || "Video chunk analysis failed.").slice(0, 240);
        sectionTexts[position] = (
          `=== Window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n[Analysis failed for this window: ${reason}]`
        );
        progress.note?.(
          `Video ${label} failed (${reason}). Continuing with remaining windows...`
        );
      } finally {
        progress.finish();
      }
    });
  } catch (error) {
    if (fatalError) throw fatalError;
    throw error;
  } finally {
    context.abortSignal?.removeEventListener?.("abort", onParentAbort);
  }

  const orderedSections = sectionTexts.filter(Boolean);
  if (!orderedSections.length || failedChunkCount >= chunks.length) {
    throw new Error(
      failedChunkCount
        ? `Video analysis failed for all ${chunks.length} windows.`
        : "Video analysis returned no windows."
    );
  }

  // Compact each window before merge so the reduce pass does not re-ingest (and
  // re-narrate) every frame-by-frame dump — that was doubling work and looking like
  // the same segments being processed again.
  const compactSections = orderedSections.map((section, index) => {
    const rangeMatch = section.match(/=== Window \d+ of \d+ \(([^)]+)\) ===/);
    const rangeLabel = rangeMatch?.[1] || `window ${index + 1}`;
    return `=== Window ${index + 1} of ${orderedSections.length} (${rangeLabel}) ===\n${compactWindowNotesForMerge(section)}`;
  });

  if (deferMerge) {
    return {
      analysis: stitchWindowSections(orderedSections, chunks.length, chunkSeconds, failedChunkCount),
      sections: compactSections,
      chunkCount: chunks.length,
      failedChunkCount
    };
  }

  await context.reportProgress?.("Merging video window analyses...");
  try {
    const mergePrompt = buildVideoMergePrompt({
      requestPrompt,
      target,
      context,
      includeQuestion,
      chunkSeconds,
      sections: compactSections,
      chunkCount: chunks.length,
      failedChunkCount
    });
    const mergeSettings = mergeProviderSettings || providerSettings;
    const merged = await callVideoChunkAnalysis(mergeSettings, {
      kind: "video",
      prompt: mergePrompt,
      images: [],
      target,
      signal: context.abortSignal
    }, {
      label: "video merge",
      reportProgress: context.reportProgress
    });
    const mergeLabel = `${mergeSettings.provider}:${mergeSettings.model}`;
    const header = [
      `Combined video analysis merged from ${chunks.length} consecutive ~${chunkSeconds}s windows (map-reduce; merge model ${mergeLabel}).`,
      failedChunkCount
        ? `${failedChunkCount} window${failedChunkCount === 1 ? "" : "s"} failed during mapping and were noted; remaining windows still contain visual evidence.`
        : "Each window was analyzed independently, then a text-only merge unified recurring people/objects across the timeline.",
      "All timestamps are absolute clip time."
    ].join(" ");
    return {
      analysis: [header, "", String(merged || "").trim()].filter(Boolean).join("\n"),
      sections: compactSections,
      chunkCount: chunks.length,
      failedChunkCount
    };
  } catch (error) {
    if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
    if (isFatalMediaProviderError(error)) {
      throw new Error(
        `${error.message} Try a larger-context text model for Video merge in AskLocal settings, or lower Parallel video chunks.`
      );
    }
    await context.reportProgress?.(
      `Video merge failed (${String(error?.message || "merge failed").slice(0, 160)}). Using stitched windows...`
    );
    return {
      analysis: stitchWindowSections(orderedSections, chunks.length, chunkSeconds, failedChunkCount, {
        mergeFailed: true,
        mergeError: String(error?.message || "merge failed").slice(0, 240)
      }),
      sections: compactSections,
      chunkCount: chunks.length,
      failedChunkCount
    };
  }
}

function stitchWindowSections(sectionTexts, chunkCount, chunkSeconds, failedChunkCount, options = {}) {
  const header = [
    `Combined video analysis stitched from ${chunkCount} consecutive ~${chunkSeconds}s windows.`,
    options.mergeFailed
      ? `Window merge failed (${options.mergeError || "unknown error"}); showing ordered window notes instead.`
      : "Windows were analyzed independently (map phase); continuity comes from the merge pass when available.",
    failedChunkCount
      ? `${failedChunkCount} window${failedChunkCount === 1 ? "" : "s"} failed and were marked in place; remaining windows still contain visual evidence.`
      : "",
    "All timestamps are absolute clip time."
  ].filter(Boolean).join(" ");
  return [header, "", sectionTexts.join("\n\n")].join("\n");
}

export function buildVideoMergePrompt({
  requestPrompt,
  target,
  context,
  includeQuestion,
  chunkSeconds,
  sections,
  chunkCount,
  failedChunkCount
}) {
  return [
    "You are merging compact notes from independent video-window analyses for AskLocal.",
    "You will NOT receive frames. Each window note is already a SHORT change-based digest — do not invent visuals beyond those digests.",
    requestPrompt ? `User/model focus: ${requestPrompt}` : "",
    `There are ${chunkCount} consecutive ~${chunkSeconds}s windows.`,
    failedChunkCount
      ? `${failedChunkCount} window${failedChunkCount === 1 ? "" : "s"} failed analysis; preserve those failure notes and do not invent their content.`
      : "",
    "Merge requirements:",
    "- Produce ONE concise unified analysis. Do NOT restate each window at length.",
    "- Do NOT repeat the same scene/event under multiple windows if the digests describe the same ongoing action.",
    "- Unify recurring people/objects/locations across windows (consistent names once established).",
    "- Keep absolute timestamps and important on-screen text.",
    "- Keep length proportional: a short timeline, not a rewrite of every digest.",
    "- Do not answer the user directly.",
    "Use this format:",
    "Video summary: 2-5 sentences covering the full clip.",
    "Timeline: ordered bullets with absolute timestamps / ranges covering the main events (no per-frame bullets).",
    "On-screen text: notable text with timestamps (or 'none').",
    "People/objects/setting: unified roster with enough detail to recognize them.",
    "Uncertainty: brief notes on gaps, failed windows, or ambiguity.",
    formatMediaPostContext(target, context, { includeQuestion: Boolean(includeQuestion), compact: true }),
    "",
    "Compact window digests to merge (already shortened — do not expand):",
    sections.join("\n\n")
  ].filter(Boolean).join("\n");
}

/**
 * Single text-only merge after both video and audio map phases finish.
 * Combines visual + auditory window notes into one coherent media analysis.
 */
export async function mergeAudioVideoAnalysis({
  requestPrompt,
  target,
  context,
  includeQuestion,
  chunkSeconds,
  videoSections,
  audioSections,
  videoChunkCount,
  audioChunkCount,
  videoFailedChunkCount = 0,
  audioFailedChunkCount = 0,
  mergeProviderSettings
}) {
  const compactVideo = (videoSections || []).map((section, index) => {
    const text = String(section || "").trim();
    const rangeMatch = text.match(/=== (?:Visual )?Window \d+(?: of \d+)? \(([^)]+)\) ===/i)
      || text.match(/=== Window \d+ of \d+ \(([^)]+)\) ===/);
    const label = rangeMatch?.[1] || `window ${index + 1}`;
    return `=== Visual window (${label}) ===\n${compactWindowNotesForMerge(text)}`;
  });
  const compactAudio = (audioSections || []).map((section, index) => {
    const text = String(section || "").trim();
    const rangeMatch = text.match(/=== Audio window(?: \d+ of \d+)? \(([^)]+)\) ===/i);
    const label = rangeMatch?.[1] || `window ${index + 1}`;
    const body = text
      .replace(/^=== Audio[^\n]*===\n?/, "")
      .trim();
    return `=== Audio window (${label}) ===\n${body.slice(0, 2400)}`;
  });

  const mergePrompt = buildAudioVideoMergePrompt({
    requestPrompt,
    target,
    context,
    includeQuestion,
    chunkSeconds,
    videoSections: compactVideo,
    audioSections: compactAudio,
    videoChunkCount,
    audioChunkCount,
    videoFailedChunkCount,
    audioFailedChunkCount
  });

  try {
    const merged = await callVideoChunkAnalysis(mergeProviderSettings, {
      kind: "video",
      prompt: mergePrompt,
      images: [],
      target,
      signal: context.abortSignal
    }, {
      label: "audio+video merge",
      reportProgress: context.reportProgress
    });
    const mergeLabel = `${mergeProviderSettings.provider}:${mergeProviderSettings.model}`;
    const header = [
      `Combined audiovisual analysis (strategy ${AV_ANALYSIS_MERGE_STRATEGY}; merge model ${mergeLabel}).`,
      `Mapped ${videoChunkCount} visual window${videoChunkCount === 1 ? "" : "s"} and ${audioChunkCount} audio window${audioChunkCount === 1 ? "" : "s"}, then merged into one report.`,
      (videoFailedChunkCount || audioFailedChunkCount)
        ? `Mapping failures: visual ${videoFailedChunkCount}, audio ${audioFailedChunkCount}.`
        : "",
      "All timestamps are absolute clip time."
    ].filter(Boolean).join(" ");
    return {
      analysis: [header, "", String(merged || "").trim()].filter(Boolean).join("\n")
    };
  } catch (error) {
    if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
    await context.reportProgress?.(
      `Audio+video merge failed (${String(error?.message || "merge failed").slice(0, 160)}). Using separate notes...`
    );
    return {
      analysis: [
        `Audiovisual merge failed (${String(error?.message || "merge failed").slice(0, 240)}); showing mapped notes separately.`,
        "",
        "=== Visual notes ===",
        compactVideo.join("\n\n") || "(none)",
        "",
        "=== Audio notes ===",
        compactAudio.join("\n\n") || "(none)"
      ].join("\n")
    };
  }
}

export function buildAudioVideoMergePrompt({
  requestPrompt,
  target,
  context,
  includeQuestion,
  chunkSeconds,
  videoSections,
  audioSections,
  videoChunkCount,
  audioChunkCount,
  videoFailedChunkCount,
  audioFailedChunkCount
}) {
  return [
    "You are merging SEPARATE visual-window notes and audio-window notes from the same video into ONE coherent audiovisual analysis for AskLocal.",
    "You will NOT receive frames or audio clips — only text digests from earlier map passes. Do not invent visuals or speech beyond those digests.",
    requestPrompt ? `User/model focus: ${requestPrompt}` : "",
    `Visual windows: ${videoChunkCount} (~${chunkSeconds}s each). Audio windows: ${audioChunkCount}.`,
    videoFailedChunkCount || audioFailedChunkCount
      ? `Failed windows — visual: ${videoFailedChunkCount || 0}, audio: ${audioFailedChunkCount || 0}. Preserve failure notes; do not invent missing content.`
      : "",
    "Merge requirements:",
    "- Produce ONE unified report that interleaves what is SEEN and what is HEARD on a shared timeline.",
    "- Align speech/sounds with visible action when timestamps overlap; call out mismatches.",
    "- Prefer exact transcript lines and on-screen text from the digests; do not duplicate the same speech in both Speech/transcript and On-screen text when they match.",
    "- Unify recurring people/speakers/objects across windows.",
    "- Do NOT dump every per-frame or per-chunk note; keep it proportional and scannable.",
    "- Do not answer the user directly.",
    "Use this format:",
    "Summary: 3-6 sentences covering the full clip (visual + audio).",
    "Timeline: ordered bullets with absolute timestamps / ranges covering main audiovisual events.",
    "Speech/transcript: unified timestamped speech (or 'none').",
    "On-screen text: notable text with timestamps that is not already in Speech/transcript (or 'none').",
    "Non-speech audio: music/SFX/ambience that matters.",
    "People/speakers/setting: unified roster.",
    "Uncertainty: gaps, failed windows, or A/V mismatches.",
    formatMediaPostContext(target, context, { includeQuestion: Boolean(includeQuestion), compact: true }),
    "",
    "Visual window digests:",
    (videoSections || []).join("\n\n") || "(none)",
    "",
    "Audio window digests:",
    (audioSections || []).join("\n\n") || "(none)"
  ].filter(Boolean).join("\n");
}

/** Shrink a full window analysis to the bits the merge pass actually needs. */
export function compactWindowNotesForMerge(section, maxChars = 700) {
  const text = String(section || "").trim();
  if (!text) return "(empty window notes)";
  const cap = clampNumber(maxChars, 300, 2500, 700);

  const failed = text.match(/\[Analysis failed for this window:[^\]]+\]/);
  if (failed) return failed[0];

  const parts = [];
  const summary = text.match(/(?:Window|Video) summary:\s*([\s\S]*?)(?=\n(?:Timeline:|Frame-by-frame:|On-screen text:|People\/objects\/setting:|Carry-forward:|Uncertainty:|$))/i)?.[1]?.trim();
  if (summary) parts.push(`Summary: ${summary}`);

  const timeline = text.match(/Timeline:\s*([\s\S]*?)(?=\n(?:On-screen text:|People\/objects\/setting:|Carry-forward:|Uncertainty:|$))/i)?.[1]?.trim();
  if (timeline) parts.push(`Timeline:\n${timeline.slice(0, 450)}`);

  const onScreen = text.match(/On-screen text:\s*([\s\S]*?)(?=\n(?:People\/objects\/setting:|Carry-forward:|Uncertainty:|$))/i)?.[1]?.trim();
  if (onScreen && !/^none\b/i.test(onScreen)) {
    parts.push(`On-screen text:\n${onScreen.slice(0, 300)}`);
  }

  const people = text.match(/People\/objects\/setting:\s*([\s\S]*?)(?=\n(?:Carry-forward:|Uncertainty:|$))/i)?.[1]?.trim();
  if (people) parts.push(`People/objects/setting: ${people.slice(0, 280)}`);

  const uncertainty = text.match(/Uncertainty:\s*([\s\S]*?)$/i)?.[1]?.trim();
  if (uncertainty) parts.push(`Uncertainty: ${uncertainty.slice(0, 160)}`);

  const compact = parts.join("\n").trim();
  if (compact) return compact.slice(0, cap);

  // Fallback: drop legacy frame-by-frame blocks if present, then truncate.
  const withoutFrames = text
    .replace(/Frame-by-frame:[\s\S]*?(?=\n(?:On-screen text:|People\/objects\/setting:|Carry-forward:|Uncertainty:|$))/i, "")
    .replace(/^=== Window[^\n]*===\n?/, "")
    .trim();
  return (withoutFrames || text).slice(0, cap);
}

/**
 * Run `worker(index)` for indices 0..total-1 with at most `concurrency` in flight.
 */
export async function runWithConcurrency(total, concurrency, worker) {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
  let nextIndex = 0;

  async function runOne() {
    while (nextIndex < total) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => runOne()));
}

export async function callVideoChunkAnalysis(providerSettings, request, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs, 30_000, 15 * 60_000, MEDIA_ANALYSIS_CHUNK_TIMEOUT_MS);
  const heartbeatMs = clampNumber(options.heartbeatMs, 5_000, 60_000, MEDIA_ANALYSIS_CHUNK_HEARTBEAT_MS);
  const label = options.label || "video analysis";
  const reportProgress = options.reportProgress;
  const onHeartbeat = typeof options.onHeartbeat === "function" ? options.onHeartbeat : null;
  const parentSignal = request.signal;

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) throw new DOMException("The request was stopped.", "AbortError");
  parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });

  const startedAt = Date.now();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (onHeartbeat) {
      onHeartbeat(seconds);
      return;
    }
    void reportProgress?.(
      `Still analyzing ${label}${options.rangeLabel ? ` (${options.rangeLabel})` : ""} — ${seconds}s...`
    );
  }, heartbeatMs);

  try {
    return await callMediaAnalysisProvider(providerSettings, {
      ...request,
      systemPrompt: request.systemPrompt || (request.kind === "video" ? VIDEO_ANALYSIS_SYSTEM_PROMPT : ""),
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}. The vision model may be overloaded or stuck on this window.`
      );
    }
    if (error?.name === "AbortError" || parentSignal?.aborted) {
      throw new DOMException("The request was stopped.", "AbortError");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    parentSignal?.removeEventListener?.("abort", onParentAbort);
  }
}
export function compactPreviousWindowNotes(section, maxChars = MEDIA_ANALYSIS_CARRY_FORWARD_CHARS) {
  const text = String(section || "").trim();
  if (!text) return "";
  const cap = clampNumber(maxChars, 200, 4000, MEDIA_ANALYSIS_CARRY_FORWARD_CHARS);

  const carry = text.match(/Carry-forward:\s*([\s\S]*?)(?=\n(?:Uncertainty:|$))/i)?.[1]?.trim();
  if (carry) return carry.slice(0, cap);

  const windowSummary = text.match(/(?:Window|Video) summary:\s*([\s\S]*?)(?=\n(?:Timeline:|Frame-by-frame:|$))/i)?.[1]?.trim();
  if (windowSummary) return windowSummary.slice(0, cap);

  return text.slice(0, cap);
}
export function groupVideoFramesIntoChunks(frames, chunkSeconds) {
  const seconds = clampNumber(chunkSeconds, MIN_VIDEO_CHUNK_SECONDS, MAX_VIDEO_CHUNK_SECONDS, DEFAULT_VIDEO_CHUNK_SECONDS);
  const sorted = [...frames]
    .filter((frame) => frame && frame.dataUrl)
    .sort((left, right) => (Number(left.timestampSeconds) || 0) - (Number(right.timestampSeconds) || 0));
  if (!sorted.length) return [];

  const byIndex = new Map();
  for (const frame of sorted) {
    const index = Math.floor(Math.max(0, Number(frame.timestampSeconds) || 0) / seconds);
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index).push(frame);
  }

  return [...byIndex.keys()].sort((left, right) => left - right).map((index) => {
    const chunkFrames = byIndex.get(index);
    const startSeconds = index * seconds;
    const endSeconds = (index + 1) * seconds;
    return {
      frames: chunkFrames,
      startSeconds,
      endSeconds,
      rangeLabel: `${formatSeconds(startSeconds)}\u2013${formatSeconds(endSeconds)}`
    };
  });
}
export function buildVideoFrameCacheKey(target, context, maxFrames, frameIntervalSeconds, framesPerMinute, options = {}) {
  return `${MEDIA_CACHE_PREFIX}frames:${stableHash(JSON.stringify({
    sessionId: context.mediaSessionId || "",
    media: mediaCacheFingerprint(target),
    maxFrames,
    frameIntervalSeconds,
    framesPerMinute,
    includeAudio: Boolean(options.includeAudio),
    chunkSeconds: options.includeAudio ? Number(options.chunkSeconds || 0) : 0,
    cull: "avghash-v1"
  }))}`;
}
export async function collectVideoAnalysisFramesOnce(target, context, maxFrames, frameIntervalSeconds, framesPerMinute, options = {}) {
  const frameCacheKey = buildVideoFrameCacheKey(target, context, maxFrames, frameIntervalSeconds, framesPerMinute, options);
  const cachedFrames = MEDIA_FRAME_CACHE.get(frameCacheKey);
  if (cachedFrames) {
    rememberLimitedCache(MEDIA_FRAME_CACHE, frameCacheKey, cachedFrames, MEDIA_FRAME_CACHE_LIMIT, context.mediaSessionId);
    return Array.isArray(cachedFrames)
      ? { frames: cachedFrames, audioChunks: [], rawVideoUrl: "", error: "" }
      : cachedFrames;
  }

  const capture = await collectVideoAnalysisFrames(target, context, maxFrames, frameIntervalSeconds, framesPerMinute, options);
  if (capture.frames.length || capture.audioChunks?.length) {
    rememberLimitedCache(MEDIA_FRAME_CACHE, frameCacheKey, capture, MEDIA_FRAME_CACHE_LIMIT, context.mediaSessionId);
  }
  return capture;
}
export async function collectVideoAnalysisFrames(target, context, maxFrames, frameIntervalSeconds, framesPerMinute, options = {}) {
  const frames = [];
  const addFrame = (frame) => {
    const normalized = normalizeAnalysisImage(frame);
    if (!normalized.ok) return;
    if (frames.some((existing) => existing.dataUrl === normalized.dataUrl)) return;
    frames.push(normalized);
  };

  // Resolve a raw video.twimg.com MP4, then capture frames either in Chrome's
  // offscreen document or (Firefox) an inactive extension tab running the same
  // video-capture page. Fall back to sampling the visible X <video> only if that fails.
  const directUrls = await resolveRawVideoUrlsForTarget(target, context);
  const audioUrls = [
    ...(Array.isArray(options.audioUrls) ? options.audioUrls : []),
    ...getTargetRawAudioUrls(target)
  ].filter(Boolean);
  let rawVideoUrl = directUrls[0] || "";
  let audioChunks = [];
  let error = "";
  let audioError = "";

  if (directUrls.length) {
    try {
      for (const directUrl of directUrls) {
        const capture = await captureVideoFromDirectUrl(
          directUrl,
          maxFrames,
          frameIntervalSeconds,
          framesPerMinute,
          context.reportProgress,
          {
            includeAudio: Boolean(options.includeAudio),
            chunkSeconds: options.chunkSeconds,
            audioUrl: audioUrls[0] || "",
            streamWindows: options.streamWindows !== false,
            onVideoWindow: options.onVideoWindow,
            onAudioChunk: options.onAudioChunk,
            onCaptureMeta: options.onCaptureMeta
          }
        );
        const bgFrames = Array.isArray(capture) ? capture : (capture.frames || []);
        if (!bgFrames.length && !(capture.audioChunks || []).length) continue;
        bgFrames.forEach(addFrame);
        if (Array.isArray(capture.audioChunks) && capture.audioChunks.length) {
          audioChunks = capture.audioChunks;
        }
        if (capture.audioError) audioError = capture.audioError;
        rawVideoUrl = directUrl;
        if (frames.length >= (maxFrames || 1)) break;
      }
      if (!frames.length) {
        error = "Opened raw video URL, but no readable frames were captured.";
      }
    } finally {
      await releaseVideoCaptureTab();
    }
  } else {
    error = "No raw video.twimg.com MP4 URL was resolved for this X video.";
  }

  if (!frames.length && context.sourceTabId) {
    await context.reportProgress?.("Capturing video frames from the open X tab...");
    const tabCapture = await collectSourceTabMediaCapture(
      context.sourceTabId,
      target,
      maxFrames,
      frameIntervalSeconds,
      framesPerMinute,
      { metadataOnly: false }
    );
    (tabCapture.frames || []).forEach(addFrame);
    if (tabCapture.rawVideoUrl) rawVideoUrl = tabCapture.rawVideoUrl;
    else if (tabCapture.srcUrl && !rawVideoUrl) rawVideoUrl = tabCapture.srcUrl;
    if (Array.isArray(tabCapture.rawAudioUrls) && tabCapture.rawAudioUrls.length) {
      target.rawAudioUrls = normalizeRawAudioUrls([
        ...(target.rawAudioUrls || []),
        ...tabCapture.rawAudioUrls
      ]);
    }
    if (!frames.length && tabCapture.error) error = tabCapture.error;
  }

  if (!frames.length) {
    return {
      frames: [],
      audioChunks,
      rawVideoUrl: rawVideoUrl || "",
      error: error || "Could not capture readable video frames.",
      audioError
    };
  }

  const limited = maxFrames === 0 ? frames : frames.slice(0, maxFrames);
  const culled = await cullNearDuplicateFrames(limited, {
    subtitleChangeTimes: collectSubtitleChangeTimes(target.videoSubtitles)
  });

  return {
    frames: culled,
    audioChunks,
    rawVideoUrl: rawVideoUrl || "",
    error: "",
    audioError: audioChunks.length ? "" : audioError
  };
}
export async function resolveRawVideoUrlsForTarget(target, context) {
  const candidates = [];
  const add = (candidate) => addTweetVideoCandidate(candidates, candidate);

  getTargetRawVideoUrls(target).forEach((url) => add({ url, source: "target" }));

  if (!candidates.length && context.sourceTabId) {
    try {
      const capture = await collectSourceTabMediaCapture(context.sourceTabId, target, 0, 1, 0, { metadataOnly: true });
      getTargetRawVideoUrls(capture).forEach((url) => add({ url, source: "active_tab_metadata" }));
      if (capture.mediaId && !target.mediaId) target.mediaId = capture.mediaId;
    } catch {
      // Best-effort: metadata services below can still resolve by status id.
    }
  }

  const statusId = String(target.statusId || extractStatusIdFromUrl(target.postUrl) || extractStatusIdFromUrl(target.url) || "");
  if (statusId) {
    await context.reportProgress?.("Resolving raw video URL...");
    const metadataCandidates = await fetchTweetVideoUrlCandidates(statusId, context.abortSignal);
    metadataCandidates.forEach(add);
  }

  return rankTweetVideoCandidatesForCapture(
    selectTweetVideoCandidatesForTarget(candidates, target)
  ).map((candidate) => candidate.url);
}
export function getTargetRawVideoUrls(target) {
  return [
    ...(Array.isArray(target?.rawVideoUrls) ? target.rawVideoUrls : []),
    target?.rawVideoUrl,
    target?.srcUrl,
    target?.videoUrl,
    target?.url
  ].filter(Boolean);
}
export function getTargetRawAudioUrls(target) {
  return normalizeRawAudioUrls([
    ...(Array.isArray(target?.rawAudioUrls) ? target.rawAudioUrls : []),
    target?.rawAudioUrl,
    target?.audioUrl
  ]);
}
export function addTweetVideoCandidate(candidates, candidate) {
  const url = normalizePlayableTweetVideoUrl(typeof candidate === "string" ? candidate : candidate?.url);
  if (!url) return;
  const existing = candidates.find((item) => normalizeSourceUrl(item.url) === normalizeSourceUrl(url));
  const next = {
    url,
    bitrate: Number(candidate?.bitrate || candidate?.bit_rate || 0) || bitrateFromTweetVideoUrl(url),
    width: Number(candidate?.width || candidate?.w || candidate?.size?.width || 0) || widthFromTweetVideoUrl(url),
    height: Number(candidate?.height || candidate?.h || candidate?.size?.height || 0) || heightFromTweetVideoUrl(url),
    mediaId: String(candidate?.mediaId || candidate?.media_id || candidate?.id_str || candidate?.id || extractTweetVideoMediaId(url) || ""),
    source: String(candidate?.source || "")
  };
  if (existing) {
    Object.assign(existing, {
      bitrate: Math.max(existing.bitrate || 0, next.bitrate || 0),
      width: Math.max(existing.width || 0, next.width || 0),
      height: Math.max(existing.height || 0, next.height || 0),
      mediaId: existing.mediaId || next.mediaId,
      source: existing.source || next.source
    });
    return;
  }
  candidates.push(next);
}
/**
 * Prefer the lightest variant that still meets our encode cap (720px longest side).
 * Oversized/high-bitrate files only slow download+seek; we downscale before analysis anyway.
 * Larger variants remain later in the list as capture fallbacks.
 */
export function rankTweetVideoCandidatesForCapture(candidates) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  if (list.length <= 1) return list;

  const targetSide = VIDEO_FRAME_MAX_SIDE;
  const withSize = list.map((candidate) => {
    const width = Number(candidate.width || 0) || widthFromTweetVideoUrl(candidate.url);
    const height = Number(candidate.height || 0) || heightFromTweetVideoUrl(candidate.url);
    const longSide = Math.max(width, height);
    const bitrate = Number(candidate.bitrate || 0) || bitrateFromTweetVideoUrl(candidate.url);
    const pixels = Math.max(1, width * height);
    return { candidate, width, height, longSide, bitrate, pixels };
  });

  const adequate = withSize.filter((item) => item.longSide >= targetSide);
  const pool = adequate.length ? adequate : withSize;

  pool.sort((left, right) => {
    // Among variants that meet the encode cap, prefer smaller files (bitrate, then pixels).
    if (adequate.length) {
      if (left.bitrate && right.bitrate && left.bitrate !== right.bitrate) {
        return left.bitrate - right.bitrate;
      }
      if (left.pixels !== right.pixels) return left.pixels - right.pixels;
      return left.longSide - right.longSide;
    }
    // Nothing reaches 720: prefer the largest available so we don't undersample.
    if (right.longSide !== left.longSide) return right.longSide - left.longSide;
    if (right.bitrate !== left.bitrate) return right.bitrate - left.bitrate;
    return right.pixels - left.pixels;
  });

  const ranked = pool.map((item) => item.candidate);
  // Append remaining candidates (not in preferred pool) as fallbacks, highest quality first.
  const seen = new Set(ranked.map((candidate) => normalizeSourceUrl(candidate.url)));
  const leftovers = withSize
    .filter((item) => !seen.has(normalizeSourceUrl(item.candidate.url)))
    .sort((left, right) => scoreTweetVideoCandidate(right.candidate) - scoreTweetVideoCandidate(left.candidate))
    .map((item) => item.candidate);
  return [...ranked, ...leftovers];
}
export function normalizePlayableTweetVideoUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return isRawTweetVideoFileUrl(url.href) ? url.href : "";
  } catch {
    return "";
  }
}
export function normalizePlayableTweetAudioUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return isRawTweetAudioFileUrl(url.href) ? url.href : "";
  } catch {
    return "";
  }
}
export function selectTweetVideoCandidatesForTarget(candidates, target) {
  const targetMediaId = String(target.mediaId || extractTweetVideoMediaId(target.srcUrl || target.posterUrl || target.url) || "");
  if (!targetMediaId) return candidates;
  const matching = candidates.filter((candidate) => candidate.mediaId === targetMediaId || candidate.url.includes(`/${targetMediaId}/`));
  return matching.length ? matching : candidates;
}
export async function fetchTweetVideoUrlCandidates(statusId, signal) {
  const endpoints = [
    `https://api.fxtwitter.com/status/${encodeURIComponent(statusId)}`,
    `https://api.vxtwitter.com/Twitter/status/${encodeURIComponent(statusId)}`
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal
      });
      if (!response.ok) continue;
      const data = await response.json();
      const candidates = extractTweetVideoUrlCandidates(data, endpoint);
      if (candidates.length) return candidates;
    } catch {
      // Try the next metadata service; callers fail loudly if no raw URL resolves.
    }
  }

  return [];
}
export function extractTweetVideoUrlCandidates(value, source = "") {
  const candidates = [];
  const seenObjects = new WeakSet();

  const walk = (node, context = {}) => {
    if (!node) return;
    if (typeof node === "string") {
      addTweetVideoCandidate(candidates, { url: node, source, ...context });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, context));
      return;
    }
    if (typeof node !== "object" || seenObjects.has(node)) return;
    seenObjects.add(node);

    const mediaId = String(
      context.mediaId
      || extractTweetVideoMediaId(node.url)
      || extractTweetVideoMediaId(node.thumbnail_url)
      || extractTweetVideoMediaId(node.thumbnailUrl)
      || (isLikelyTweetMediaId(node.id_str) ? node.id_str : "")
      || (isLikelyTweetMediaId(node.id) ? node.id : "")
      || ""
    );
    const nextContext = {
      mediaId,
      bitrate: Number(node.bitrate || node.bit_rate || context.bitrate || 0) || 0,
      width: Number(node.width || node.w || node.size?.width || context.width || 0) || 0,
      height: Number(node.height || node.h || node.size?.height || context.height || 0) || 0
    };

    if (node.url) addTweetVideoCandidate(candidates, { url: node.url, source, ...nextContext });
    if (node.media_url_https) addTweetVideoCandidate(candidates, { url: node.media_url_https, source, ...nextContext });

    Object.values(node).forEach((child) => walk(child, nextContext));
  };

  walk(value);
  return candidates;
}
export function isLikelyTweetMediaId(value) {
  return /^\d{8,}$/.test(String(value || ""));
}
export function scoreTweetVideoCandidate(candidate) {
  return Number(candidate.bitrate || 0)
    || (Number(candidate.width || 0) * Number(candidate.height || 0))
    || scoreRawTweetVideoUrl(candidate.url);
}
export function scoreRawTweetVideoUrl(value) {
  return bitrateFromTweetVideoUrl(value) || (widthFromTweetVideoUrl(value) * heightFromTweetVideoUrl(value)) || 1;
}
export function bitrateFromTweetVideoUrl(value) {
  try {
    const text = `${new URL(value).pathname} ${new URL(value).search}`.toLowerCase();
    return Number(text.match(/(?:^|[_/-])(\d{3,5})k(?:[_/.?-]|$)/)?.[1] || 0);
  } catch {
    return 0;
  }
}
export function widthFromTweetVideoUrl(value) {
  try {
    return Number(new URL(value).pathname.match(/(\d{3,4})x(\d{3,4})/)?.[1] || 0);
  } catch {
    return 0;
  }
}
export function heightFromTweetVideoUrl(value) {
  try {
    return Number(new URL(value).pathname.match(/(\d{3,4})x(\d{3,4})/)?.[2] || 0);
  } catch {
    return 0;
  }
}
export function extractTweetVideoMediaId(value) {
  try {
    const url = new URL(value);
    return url.pathname.match(/\/(?:amplify_video|ext_tw_video|tweet_video|tweet_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\/([^/]+)/)?.[1] || "";
  } catch {
    return "";
  }
}
export let videoCaptureOffscreenPromise = null;
export let videoCaptureTabId = null;
export let videoCaptureTabPromise = null;

export async function captureVideoFromDirectUrl(videoUrl, maxFrames, frameIntervalSeconds, framesPerMinute, progress, options = {}) {
  try {
    const usingOffscreen = Boolean(api.offscreen?.createDocument);
    await progress?.(usingOffscreen
      ? "Preparing offscreen video capture..."
      : "Opening a background tab for video capture...");
    await ensureVideoCaptureHost();
    const response = await sendVideoCaptureMessage({
      videoUrl,
      maxFrames,
      frameIntervalSeconds,
      framesPerMinute,
      includeAudio: Boolean(options.includeAudio),
      chunkSeconds: options.chunkSeconds,
      audioUrl: String(options.audioUrl || "").trim(),
      streamWindows: options.streamWindows !== false
    }, {
      onProgress: typeof progress === "function" ? progress : options.onProgress,
      onVideoWindow: options.onVideoWindow,
      onAudioChunk: options.onAudioChunk,
      onCaptureMeta: options.onCaptureMeta
    });
    if (!response?.ok) {
      return { frames: [], audioChunks: [], audioError: response?.error || "" };
    }
    return {
      frames: Array.isArray(response.frames) ? response.frames : [],
      audioChunks: Array.isArray(response.audioChunks) ? response.audioChunks : [],
      audioError: String(response.audioError || "")
    };
  } catch (error) {
    console.warn("AskLocal raw video capture failed", error);
    return { frames: [], audioChunks: [], audioError: error?.message || "" };
  }
}

export async function ensureVideoCaptureHost() {
  if (api.offscreen?.createDocument) {
    await ensureVideoCaptureOffscreenDocument();
    return;
  }
  await ensureVideoCaptureTab();
}

export async function ensureVideoCaptureOffscreenDocument() {
  if (!api.offscreen?.createDocument) {
    throw new Error("Chrome offscreen documents are unavailable; raw video capture cannot run without focusing a tab.");
  }

  const documentUrl = api.runtime.getURL("video-capture.html");
  if (await hasVideoCaptureOffscreenDocument(documentUrl)) return;

  if (!videoCaptureOffscreenPromise) {
    videoCaptureOffscreenPromise = api.offscreen.createDocument({
      url: "video-capture.html",
      reasons: ["DOM_SCRAPING"],
      justification: "Capture frames from resolved raw video URLs without focusing or interrupting the user."
    }).catch(async (error) => {
      if (String(error?.message || "").toLowerCase().includes("single offscreen")) return;
      if (await hasVideoCaptureOffscreenDocument(documentUrl)) return;
      throw error;
    }).finally(() => {
      videoCaptureOffscreenPromise = null;
    });
  }

  await videoCaptureOffscreenPromise;
}

export async function ensureVideoCaptureTab() {
  if (!api.tabs?.create) {
    throw new Error("Background tab video capture is unavailable in this browser.");
  }

  const documentUrl = api.runtime.getURL("video-capture.html");
  if (videoCaptureTabId != null) {
    try {
      const existing = await api.tabs.get(videoCaptureTabId);
      if (existing?.id != null) return existing.id;
    } catch {
      videoCaptureTabId = null;
    }
  }

  if (!videoCaptureTabPromise) {
    videoCaptureTabPromise = (async () => {
      const matches = await api.tabs.query({ url: documentUrl }).catch(() => []);
      const reusable = matches.find((tab) => tab?.id != null);
      if (reusable?.id != null) {
        videoCaptureTabId = reusable.id;
        await waitForTabComplete(reusable.id);
        return reusable.id;
      }

      const created = await api.tabs.create({
        url: documentUrl,
        active: false
      });
      if (created?.id == null) throw new Error("Could not open the video capture tab.");
      videoCaptureTabId = created.id;
      await waitForTabComplete(created.id);
      // Give the capture page a tick to attach its runtime listener.
      await sleep(50);
      return created.id;
    })().finally(() => {
      videoCaptureTabPromise = null;
    });
  }

  return videoCaptureTabPromise;
}

export async function releaseVideoCaptureTab() {
  const tabId = videoCaptureTabId;
  videoCaptureTabId = null;
  if (tabId == null || api.offscreen?.createDocument) return;
  try {
    await api.tabs.remove(tabId);
  } catch {
    // Tab may already be closed by the user.
  }
}

export async function waitForTabComplete(tabId, timeoutMs = 15000) {
  try {
    const tab = await api.tabs.get(tabId);
    if (tab?.status === "complete") return;
  } catch {
    throw new Error("Video capture tab disappeared before it finished loading.");
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      api.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for the video capture tab to load."));
    }, timeoutMs);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    api.tabs.onUpdated.addListener(onUpdated);
  });
}

export async function hasVideoCaptureOffscreenDocument(documentUrl) {
  if (!api.runtime.getContexts) return false;
  try {
    const contexts = await api.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function sendVideoCaptureMessage(payload, progressOrHandlers) {
  const captureId = createVideoCaptureId();
  let lastError;
  const handlers = typeof progressOrHandlers === "function"
    ? { onProgress: progressOrHandlers }
    : (progressOrHandlers || {});

  VIDEO_CAPTURE_PROGRESS_HANDLERS.set(captureId, async (message, detail) => {
    const event = String(detail?.event || "");
    if (event === "video_window" && typeof handlers.onVideoWindow === "function") {
      // Enqueue only — do not await LLM work or capture stalls on each window.
      handlers.onVideoWindow(detail.videoWindow);
      return;
    }
    if (event === "audio_chunk" && typeof handlers.onAudioChunk === "function") {
      handlers.onAudioChunk(detail.audioChunk);
      return;
    }
    if (event === "capture_meta" && typeof handlers.onCaptureMeta === "function") {
      handlers.onCaptureMeta(detail);
    }
    if (typeof handlers.onProgress === "function" && message) {
      await handlers.onProgress(message, detail);
    }
  });

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await ensureVideoCaptureHost();
        const response = await api.runtime.sendMessage({
          type: "ASKLOCAL_CAPTURE_RAW_VIDEO_FRAMES",
          payload: {
            ...payload,
            captureId
          }
        });
        if (response?.ok) return response;
        lastError = new Error(response?.error || "Video capture host returned no frames.");
      } catch (error) {
        lastError = error;
        await sleep(200 + attempt * 250);
        // If the Firefox capture tab died, reopen it on the next attempt.
        if (!api.offscreen?.createDocument) {
          videoCaptureTabId = null;
        }
      }
    }
    throw lastError ?? new Error("Could not reach the video capture host.");
  } finally {
    VIDEO_CAPTURE_PROGRESS_HANDLERS.delete(captureId);
  }
}

/** @deprecated Use sendVideoCaptureMessage */
export async function sendOffscreenVideoCaptureMessage(payload, progress) {
  return sendVideoCaptureMessage(payload, progress);
}
export async function handleVideoCaptureProgress(payload) {
  const captureId = String(payload.captureId || "");
  const message = String(payload.message || "").trim();
  if (!captureId || !message) return { ok: false, error: "Invalid video capture progress message." };

  const handler = VIDEO_CAPTURE_PROGRESS_HANDLERS.get(captureId);
  if (!handler) return { ok: false, error: "Video capture progress handler was not found." };

  await handler(message, payload.detail ?? null);
  return { ok: true };
}
export function createVideoCaptureId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `capture:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}
export async function collectSourceTabMediaCapture(tabId, target, maxFrames, frameIntervalSeconds, framesPerMinute, options = {}) {
  try {
    const response = await api.tabs.sendMessage(tabId, {
      type: "COLLECT_MEDIA_CAPTURE",
      payload: {
        id: target.id,
        contextId: target.contextId,
        statusId: target.statusId,
        url: target.url,
        mediaType: target.mediaType,
        maxFrames,
        framesPerMinute,
        frameIntervalSeconds,
        metadataOnly: Boolean(options.metadataOnly)
      }
    });
    return response?.ok ? response.capture : { frames: [] };
  } catch {
    return { frames: [] };
  }
}
export function buildVideoAnalysisPrompt(requestPrompt, target, context, frames, options = {}) {
  const chunk = options.chunk || null;
  const previousSummary = chunk?.previousSummary || null;
  const sequential = chunk?.mode === "sequential";
  const subtitles = flattenSubtitleGroups(target.videoSubtitles, chunk
    ? { startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds }
    : null);
  const hasSubtitles = Boolean(subtitles && String(subtitles).trim());

  const intro = chunk
    ? sequential
      ? [
          `Window ${chunk.position} of ${chunk.total} (${chunk.rangeLabel}). Frames below are this window only.`,
          "Write compact change-based notes for THIS window. Use previous-window notes only for continuity; do not re-describe earlier content."
        ]
      : [
          `Window ${chunk.position} of ${chunk.total} (${chunk.rangeLabel}). Frames below are this window only.`,
          "Write compact change-based notes for THIS window only. Other windows are analyzed separately."
        ]
    : [
        "Analyze these sparsely sampled video frames for AskLocal.",
        "Write compact change-based visual notes (not a per-frame dump)."
      ];

  return [
    ...intro,
    requestPrompt ? `Focus: ${requestPrompt}` : "",
    "The answering model cannot see these frames — your notes are the visual evidence. Do not answer the user.",
    hasSubtitles
      ? "Subtitle/caption cues are provided below for this window. Prefer them for speech-like text; only OCR burned-in text that is missing or differs."
      : "Transcribe distinct readable on-screen text (signs, UI, claims). Skip repeating identical captions across frames.",
    "Output format:",
    chunk
      ? `Window summary: 2-3 sentences on what happens in ${chunk.rangeLabel}.`
      : "Video summary: 2-3 sentences on the main event / claim / punchline.",
    "Timeline: bullets only for meaningful changes or key moments (timestamp or range). Do NOT write one bullet per sample when the scene is unchanged.",
    "On-screen text: distinct strings with timestamps, or 'none'. Skip text already listed in the subtitle cues below.",
    "People/objects/setting: brief roster.",
    sequential ? "Carry-forward: 1-2 sentences for the next window (who/what is in progress)." : "",
    "Uncertainty: brief gaps only.",
    "Keep this window under ~700 characters when possible.",
    "",
    previousSummary ? `Previous window continuity (${previousSummary.rangeLabel}):\n${String(previousSummary.summary || "").trim() || "(no notes)"}` : "",
    formatMediaPostContext(target, context, { includeQuestion: true, compact: true }),
    formatCompactVideoMediaLine(target),
    chunk
      ? `Frames in window: ${frames.length} (${chunk.position}/${chunk.total}, ${chunk.rangeLabel})`
      : `Frames: ${frames.length}`,
    "",
    hasSubtitles
      ? `Subtitle/caption cues for this window:\n${subtitles}`
      : "Subtitle/caption cues: none for this window"
  ].filter(Boolean).join("\n");
}
export function flattenSubtitleGroups(groups, timeRange = null) {
  if (!Array.isArray(groups)) return "";
  const startBound = Number.isFinite(Number(timeRange?.startSeconds)) ? Number(timeRange.startSeconds) : null;
  const endBound = Number.isFinite(Number(timeRange?.endSeconds)) ? Number(timeRange.endSeconds) : null;

  return groups
    .flatMap((group) => (group.cues ?? []).map((cue) => {
      const cueStart = parseTimestampToSeconds(cue.start);
      const cueEnd = parseTimestampToSeconds(cue.end);
      if (startBound != null && endBound != null) {
        // Keep cues that overlap this window. Untimed overlay cues are only kept
        // for the first window so they are not repeated in every parallel map.
        const hasTiming = cueStart != null || cueEnd != null;
        if (!hasTiming) {
          if (startBound > 0) return "";
        } else {
          const start = cueStart ?? cueEnd ?? 0;
          const end = cueEnd ?? cueStart ?? start;
          if (end < startBound || start >= endBound) return "";
        }
      }
      const time = [cue.start, cue.end].filter(Boolean).join("-");
      return `${time ? `${time}: ` : ""}${cue.text}`;
    }))
    .filter(Boolean)
    .slice(0, 120)
    .join("\n")
    .slice(0, 6000);
}
export function parseTimestampToSeconds(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const match = raw.match(/^(\d+):([0-5]?\d)(?:\.(\d+))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return minutes * 60 + seconds + fraction;
}
export function formatFrameList(frames) {
  return frames
    .map((frame, index) => {
      const timestamp = frame.timestamp || formatSeconds(frame.timestampSeconds);
      return `Frame ${index + 1}${timestamp ? ` at ${timestamp}` : ""}: ${frame.label || "sampled video frame"}`;
    })
    .join("\n");
}
export function trimStitchedAnalysis(text, cap) {
  if (text.length <= cap) return text;
  const marker = "\n[trimmed for space]";
  const sections = text.split(/\n(?==== Window \d+ of \d+ )/);
  if (sections.length <= 1) return text.slice(0, Math.max(0, cap - marker.length)) + marker;

  const header = sections[0];
  const windows = sections.slice(1);
  const budget = Math.max(windows.length * 80, cap - header.length - windows.length * marker.length);
  const perWindow = Math.floor(budget / windows.length);
  const trimmed = windows.map((section) => (
    section.length <= perWindow ? section : section.slice(0, perWindow) + marker
  ));
  return [header, ...trimmed].join("\n");
}

export function formatCompactVideoMediaLine(target) {
  if (!target) return "Video: (unknown)";
  const handle = String(target.authorHandle || "").replace(/^@/, "");
  const parts = [
    handle ? `@${handle}` : "",
    target.id ? `id=${target.id}` : "",
    target.mediaId ? `media=${target.mediaId}` : ""
  ].filter(Boolean);
  return `Video: ${parts.join(" ") || "selected clip"}`;
}

/** Enough timed caption text that a separate audio pass is usually redundant. */
export function hasSolidSubtitleCoverage(target) {
  const groups = target?.videoSubtitles;
  if (!Array.isArray(groups) || !groups.length) return false;
  const cues = groups
    .flatMap((group) => group?.cues || [])
    .filter((cue) => String(cue?.text || "").trim().length >= 2);
  if (cues.length < 4) return false;
  const totalChars = cues.reduce((sum, cue) => sum + String(cue.text || "").trim().length, 0);
  return totalChars >= 80;
}

export function collectSubtitleChangeTimes(groups) {
  if (!Array.isArray(groups)) return [];
  const times = [];
  for (const group of groups) {
    for (const cue of group?.cues || []) {
      const start = parseTimestampToSeconds(cue.start);
      if (start != null) times.push(start);
    }
  }
  return times;
}

/**
 * Drop near-duplicate frames using average-hash + max gap + subtitle cue boundaries.
 * Always keeps the first and last frame of the clip.
 */
export async function cullNearDuplicateFrames(frames, options = {}) {
  const list = Array.isArray(frames) ? frames.filter((frame) => frame?.dataUrl) : [];
  if (list.length <= 2) return list;

  const maxGap = clampNumber(options.maxGapSeconds, 1, 30, VIDEO_FRAME_MAX_GAP_SECONDS);
  const subtitleChangeTimes = Array.isArray(options.subtitleChangeTimes) ? options.subtitleChangeTimes : [];
  const sorted = [...list].sort(
    (left, right) => (Number(left.timestampSeconds) || 0) - (Number(right.timestampSeconds) || 0)
  );

  const hashes = new Map();
  const getHash = async (frame) => {
    if (hashes.has(frame)) return hashes.get(frame);
    const hash = await computeFrameAverageHash(frame.dataUrl);
    hashes.set(frame, hash);
    return hash;
  };

  const kept = [sorted[0]];
  for (let index = 1; index < sorted.length - 1; index += 1) {
    const frame = sorted[index];
    const prev = kept[kept.length - 1];
    const t = Number(frame.timestampSeconds) || 0;
    const prevT = Number(prev.timestampSeconds) || 0;
    const gap = t - prevT;

    if (gap >= maxGap) {
      kept.push(frame);
      continue;
    }

    const subtitleChanged = subtitleChangeTimes.some((time) => time > prevT && time <= t + 0.05);
    if (subtitleChanged) {
      kept.push(frame);
      continue;
    }

    const [prevHash, hash] = await Promise.all([getHash(prev), getHash(frame)]);
    if (prevHash == null || hash == null) {
      // Cannot compare visually — keep only via max-gap / subtitle rules above.
      continue;
    }
    if (hammingDistanceHex(prevHash, hash) > VIDEO_FRAME_HASH_MAX_DISTANCE) {
      kept.push(frame);
    }
  }
  kept.push(sorted[sorted.length - 1]);
  return kept;
}

export async function computeFrameAverageHash(dataUrl) {
  if (!dataUrl || typeof createImageBitmap !== "function") return null;
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const size = VIDEO_FRAME_HASH_SIZE;
    const canvas = typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(size, size)
      : (() => {
        const el = globalThis.document?.createElement?.("canvas");
        if (!el) return null;
        el.width = size;
        el.height = size;
        return el;
      })();
    if (!canvas) {
      bitmap.close?.();
      return null;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close?.();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close?.();
    const { data } = ctx.getImageData(0, 0, size, size);
    const grays = [];
    for (let i = 0; i < data.length; i += 4) {
      grays.push((data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114));
    }
    const mean = grays.reduce((sum, value) => sum + value, 0) / grays.length;
    let bits = 0n;
    for (let i = 0; i < grays.length; i += 1) {
      if (grays[i] >= mean) bits |= (1n << BigInt(i));
    }
    return bits.toString(16).padStart(Math.ceil((size * size) / 4), "0");
  } catch {
    return null;
  }
}

export function hammingDistanceHex(left, right) {
  if (!left || !right || left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number.parseInt(left[i], 16);
    const b = Number.parseInt(right[i], 16);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
    let xor = a ^ b;
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Tool-result pointer when automatic analysis already put the full report in context. */
export function compactReusedVideoToolResult(existing) {
  const target = existing?.target || null;
  const handle = String(target?.authorHandle || "").replace(/^@/, "");
  const type = target?.type || target?.mediaType || "video";
  const citeAs = handle ? `${type} from @${handle}` : type;
  const summary = extractVideoAnalysisSummary(existing?.analysis || existing?.audioAnalysis || "", 280);
  return {
    ok: true,
    tool: "analyze_video",
    type: "video",
    cached: true,
    reusedFromContext: true,
    already_in_context: true,
    citeAs,
    target: target
      ? {
        id: target.id,
        type,
        authorHandle: handle || undefined,
        citeAs
      }
      : null,
    summary,
    note: "The full analysis of this video is already in the conversation. Use it; do not call analyze_video again for the same clip."
  };
}

export function extractVideoAnalysisSummary(analysis, maxChars = 280) {
  const text = String(analysis || "").trim();
  if (!text) return "";
  const cap = clampNumber(maxChars, 80, 1200, 280);
  const summary = text.match(/(?:Video summary|Window summary|Summary):\s*([\s\S]*?)(?=\n(?:Timeline:|Frame-by-frame:|On-screen text:|Speech\/transcript:|People\/objects\/setting:|People\/speakers\/setting:|Uncertainty:|$))/i)?.[1]?.trim();
  if (summary) return summary.replace(/\s+/g, " ").slice(0, cap);
  return text.replace(/\s+/g, " ").slice(0, cap);
}

