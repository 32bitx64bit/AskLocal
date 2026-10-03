import {
  AUDIO_ANALYSIS_STRATEGY,
  DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  MEDIA_ANALYSIS_CARRY_FORWARD_CHARS,
  MEDIA_ANALYSIS_CHUNK_HEARTBEAT_MS,
  MEDIA_ANALYSIS_CHUNK_TIMEOUT_MS,
  MAX_VIDEO_CHUNK_CONCURRENCY,
  MIN_VIDEO_CHUNK_CONCURRENCY
} from "../constants.js";
import {
  clampNumber,
  formatSeconds,
  throwIfAborted
} from "../../lib/utils.js";
import {
  callAudioAnalysisProvider,
  describeMediaForModel,
  formatMediaPostContext
} from "./image.js";
import {
  createMediaChunkPoolProgress
} from "./progress.js";
import {
  isFatalMediaProviderError
} from "../providers/errors.js";
import {
  withLane
} from "../orchestrator/tasks.js";
import {
  summarizeMediaTarget
} from "../tools/inspectables.js";

/**
 * Soft-fail wrapper: returns a structured audio result without throwing into video analysis.
 */
export async function analyzeVideoAudioSafely({
  audioChunks,
  target,
  context,
  requestPrompt,
  chunkConcurrency,
  providerSettings,
  mergeProviderSettings,
  deferMerge = false,
  poolProgress = null
}) {
  try {
    if (!Array.isArray(audioChunks) || !audioChunks.length) {
      return {
        ok: false,
        audioAnalysis: "",
        sections: [],
        audioChunkCount: 0,
        failedChunkCount: 0,
        audioError: "No audio chunks were captured from this video."
      };
    }
    const run = await runAudioAnalysis({
      audioChunks,
      target,
      context,
      requestPrompt,
      chunkConcurrency,
      providerSettings,
      mergeProviderSettings,
      deferMerge,
      poolProgress
    });
    return {
      ok: true,
      audioAnalysis: run.analysis,
      sections: run.sections || [],
      audioChunkCount: run.chunkCount,
      failedChunkCount: run.failedChunkCount || 0,
      audioError: ""
    };
  } catch (error) {
    if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
    return {
      ok: false,
      audioAnalysis: "",
      sections: [],
      audioChunkCount: Array.isArray(audioChunks) ? audioChunks.length : 0,
      failedChunkCount: 0,
      audioError: String(error?.message || "Audio analysis failed.").slice(0, 400)
    };
  }
}

export async function runAudioAnalysis({
  audioChunks,
  target,
  context,
  requestPrompt,
  chunkConcurrency = DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  providerSettings,
  mergeProviderSettings = null,
  deferMerge = false,
  poolProgress = null
}) {
  const chunks = normalizeAudioChunks(audioChunks);
  if (!chunks.length) {
    throw new Error("No usable audio chunks were available for analysis.");
  }

  if (chunks.length <= 1) {
    poolProgress?.start?.();
    try {
      const prompt = buildAudioAnalysisPrompt(requestPrompt, target, context, chunks[0], { includeQuestion: true });
      const analysis = await callAudioChunkAnalysis(providerSettings, {
        kind: "audio",
        prompt,
        audioChunks: [chunks[0]],
        target,
        signal: context.abortSignal
      }, {
        label: "audio",
        reportProgress: context.reportProgress,
        onHeartbeat: poolProgress?.bindHeartbeat?.() || null
      });
      const section = analysis ? `=== Audio window 1 of 1 ===\n${analysis}` : "";
      return {
        analysis,
        sections: section ? [section] : [],
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

  if (concurrency <= 1) {
    return runSequentialAudioAnalysis({
      requestPrompt,
      target,
      context,
      chunks,
      providerSettings,
      poolProgress
    });
  }

  return runParallelAudioAnalysis({
    requestPrompt,
    target,
    context,
    chunks,
    concurrency,
    providerSettings,
    mergeProviderSettings: mergeProviderSettings || providerSettings,
    deferMerge,
    poolProgress
  });
}

async function runSequentialAudioAnalysis({
  requestPrompt,
  target,
  context,
  chunks,
  providerSettings,
  poolProgress = null
}) {
  let previousSummary = null;
  const sectionTexts = [];
  let failedChunkCount = 0;

  for (const [position, chunk] of chunks.entries()) {
    throwIfAborted(context.abortSignal);
    const label = `audio chunk ${position + 1} of ${chunks.length}`;
    poolProgress?.start?.();
    if (!poolProgress) {
      await context.reportProgress?.(`Analyzing ${label} (${chunk.rangeLabel})...`);
    }
    const prompt = buildAudioAnalysisPrompt(requestPrompt, target, context, chunk, {
      includeQuestion: true,
      chunk: {
        position: position + 1,
        total: chunks.length,
        rangeLabel: chunk.rangeLabel,
        previousSummary,
        mode: "sequential"
      }
    });
    try {
      const section = await callAudioChunkAnalysis(providerSettings, {
        kind: "audio",
        prompt,
        audioChunks: [chunk],
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
        summary: compactAudioCarryForward(section)
      };
      sectionTexts.push(`=== Audio window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n${section}`);
    } catch (error) {
      if (error?.name === "AbortError" || context.abortSignal?.aborted) throw error;
      if (isFatalMediaProviderError(error)) throw error;
      failedChunkCount += 1;
      const reason = String(error?.message || "Audio chunk analysis failed.").slice(0, 240);
      sectionTexts.push(
        `=== Audio window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n[Analysis failed for this window: ${reason}]`
      );
      previousSummary = {
        rangeLabel: chunk.rangeLabel,
        summary: `(Previous audio window ${chunk.rangeLabel} failed; continue from audible content alone.)`
      };
      if (poolProgress?.note) {
        poolProgress.note(`Audio ${label} failed (${reason}). Continuing with remaining chunks...`);
      } else {
        await context.reportProgress?.(
          `Audio ${label} failed (${reason}). Continuing with remaining chunks...`
        );
      }
    } finally {
      poolProgress?.finish?.();
    }
  }

  if (!sectionTexts.length || failedChunkCount >= chunks.length) {
    throw new Error(
      failedChunkCount
        ? `Audio analysis failed for all ${chunks.length} windows.`
        : "Audio analysis returned no windows."
    );
  }

  const header = [
    `Combined audio analysis stitched from ${chunks.length} consecutive windows.`,
    failedChunkCount
      ? `${failedChunkCount} window${failedChunkCount === 1 ? "" : "s"} failed and were marked in place.`
      : "Windows were analyzed in order with compact continuity notes.",
    "All timestamps are absolute clip time."
  ].join(" ");
  return {
    analysis: [header, "", sectionTexts.join("\n\n")].join("\n"),
    sections: sectionTexts.slice(),
    chunkCount: chunks.length,
    failedChunkCount
  };
}

async function runParallelAudioAnalysis({
  requestPrompt,
  target,
  context,
  chunks,
  concurrency,
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
    kind: "audio",
    total: chunks.length
  });

  try {
    await runWithConcurrency(chunks.length, concurrency, async (position) => {
      throwIfAborted(context.abortSignal);
      if (fatalError || poolController.signal.aborted) {
        throw fatalError || new DOMException("The request was stopped.", "AbortError");
      }

      const chunk = chunks[position];
      const label = `audio window ${position + 1}/${chunks.length}`;
      progress.start();
      const prompt = buildAudioAnalysisPrompt(requestPrompt, target, context, chunk, {
        includeQuestion: true,
        chunk: {
          position: position + 1,
          total: chunks.length,
          rangeLabel: chunk.rangeLabel,
          mode: "parallel"
        }
      });

      try {
        const section = await callAudioChunkAnalysis(providerSettings, {
          kind: "audio",
          prompt,
          audioChunks: [chunk],
          target,
          signal: poolController.signal
        }, {
          label,
          rangeLabel: chunk.rangeLabel,
          onHeartbeat: progress.bindHeartbeat()
        });
        sectionTexts[position] = `=== Audio window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n${section}`;
      } catch (error) {
        if (fatalError) throw fatalError;
        if (error?.name === "AbortError" || context.abortSignal?.aborted || poolController.signal.aborted) {
          throw error;
        }
        if (isFatalMediaProviderError(error)) {
          fatalError = error;
          poolController.abort();
          throw fatalError;
        }
        failedChunkCount += 1;
        const reason = String(error?.message || "Audio chunk analysis failed.").slice(0, 240);
        sectionTexts[position] = (
          `=== Audio window ${position + 1} of ${chunks.length} (${chunk.rangeLabel}) ===\n[Analysis failed for this window: ${reason}]`
        );
        progress.note?.(
          `Audio ${label} failed (${reason}). Continuing with remaining windows...`
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
        ? `Audio analysis failed for all ${chunks.length} windows.`
        : "Audio analysis returned no windows."
    );
  }

  const compactSections = orderedSections.map((section) => {
    const rangeMatch = section.match(/=== Audio window \d+ of \d+ \(([^)]+)\) ===/);
    const header = rangeMatch
      ? `=== Audio window (${rangeMatch[1]}) ===`
      : section.split("\n")[0];
    return `${header}\n${compactAudioCarryForward(section, 2400)}`;
  });

  if (deferMerge) {
    return {
      analysis: [orderedSections.join("\n\n")].join("\n"),
      sections: compactSections,
      chunkCount: chunks.length,
      failedChunkCount
    };
  }

  await context.reportProgress?.("Merging audio window analyses...");
  const mergePrompt = buildAudioMergePrompt({
    requestPrompt,
    target,
    context,
    sections: compactSections,
    chunkCount: chunks.length,
    failedChunkCount
  });
  const mergeSettings = mergeProviderSettings || providerSettings;
  const merged = await callAudioChunkAnalysis(mergeSettings, {
    kind: "audio",
    prompt: mergePrompt,
    audioChunks: [],
    target,
    signal: context.abortSignal
  }, {
    label: "audio merge",
    reportProgress: context.reportProgress
  });
  const mergeLabel = `${mergeSettings.provider}:${mergeSettings.model}`;
  const header = [
    `Combined audio analysis merged from ${chunks.length} windows (map-reduce; merge model ${mergeLabel}; strategy ${AUDIO_ANALYSIS_STRATEGY}).`,
    failedChunkCount
      ? `${failedChunkCount} window${failedChunkCount === 1 ? "" : "s"} failed during mapping.`
      : "Each window was analyzed independently, then a text-only merge unified speakers and recurring sounds.",
    "All timestamps are absolute clip time."
  ].join(" ");
  return {
    analysis: [header, "", String(merged || "").trim()].filter(Boolean).join("\n"),
    sections: compactSections,
    chunkCount: chunks.length,
    failedChunkCount
  };
}

/** One audio (or text-only audio merge) call, run in its orchestration lane. */
export async function callAudioChunkAnalysis(providerSettings, request, options = {}) {
  const lane = Array.isArray(request.audioChunks) && request.audioChunks.length ? "audio" : "text";
  return withLane(lane, () => callAudioChunkAnalysisNow(providerSettings, request, options), request.signal);
}
async function callAudioChunkAnalysisNow(providerSettings, request, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs, 30_000, 15 * 60_000, MEDIA_ANALYSIS_CHUNK_TIMEOUT_MS);
  const heartbeatMs = clampNumber(options.heartbeatMs, 5_000, 60_000, MEDIA_ANALYSIS_CHUNK_HEARTBEAT_MS);
  const label = options.label || "audio analysis";
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
    return await callAudioAnalysisProvider(providerSettings, {
      ...request,
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}. The audio model may be overloaded or stuck on this window.`
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

export function normalizeAudioChunks(chunks) {
  if (!Array.isArray(chunks)) return [];
  return chunks
    .map((chunk, index) => {
      const dataUrl = String(chunk?.dataUrl || "").trim();
      if (!dataUrl.startsWith("data:audio/")) return null;
      const startSeconds = Number(chunk.startSeconds);
      const endSeconds = Number(chunk.endSeconds);
      const start = Number.isFinite(startSeconds) ? startSeconds : 0;
      const end = Number.isFinite(endSeconds) ? endSeconds : start;
      const rangeLabel = String(chunk.rangeLabel || `${formatSeconds(start)}-${formatSeconds(end)}`);
      return {
        ...chunk,
        dataUrl,
        mimeType: String(chunk.mimeType || "audio/wav"),
        startSeconds: start,
        endSeconds: end,
        durationSeconds: Number.isFinite(Number(chunk.durationSeconds))
          ? Number(chunk.durationSeconds)
          : Math.max(0, end - start),
        rangeLabel,
        label: String(chunk.label || `audio chunk ${index + 1}`),
        base64: extractAudioBase64(dataUrl),
        format: inferAudioFormat(chunk.mimeType || dataUrl)
      };
    })
    .filter((chunk) => chunk?.base64);
}

export function extractAudioBase64(dataUrl) {
  const match = String(dataUrl || "").match(/^data:audio\/[^;,]+;base64,(.+)$/i);
  return match?.[1] || "";
}

export function inferAudioFormat(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("wav")) return "wav";
  if (text.includes("mp3") || text.includes("mpeg")) return "mp3";
  if (text.includes("mp4") || text.includes("m4a") || text.includes("aac")) return "mp4";
  if (text.includes("webm")) return "webm";
  if (text.includes("ogg")) return "ogg";
  return "wav";
}

export function buildAudioAnalysisPrompt(requestPrompt, target, context, chunk, options = {}) {
  const meta = options.chunk || null;
  const sequential = meta?.mode === "sequential";
  const previousSummary = meta?.previousSummary || null;
  const rangeLabel = chunk?.rangeLabel || "full clip";

  const intro = meta
    ? sequential
      ? [
          `You are analyzing ONE time window of audio from a video for AskLocal. This is window ${meta.position} of ${meta.total}, covering ${rangeLabel}.`,
          "Other windows are analyzed separately; your notes will be handed to the next window's analyst.",
          "Describe only what is audible in THIS window. Use previous continuity notes only to recognize the same speakers/sounds."
        ]
      : [
          `You are analyzing ONE time window of audio from a video for AskLocal. This is window ${meta.position} of ${meta.total}, covering ${rangeLabel}.`,
          "Other windows are analyzed separately in parallel, then a later merge pass unifies the notes.",
          "Describe ONLY what is audible in THIS window."
        ]
    : [
        "Analyze the provided audio from a video for AskLocal.",
        "Your job is to produce a detailed description of speech and non-speech sound."
      ];

  return [
    ...intro,
    requestPrompt ? `User/model focus: ${requestPrompt}` : "",
    "You are the only model that will hear this audio. The answering model cannot hear the clip and will treat your notes as primary auditory evidence. Do not answer the user directly.",
    "Be factual. Never invent dialogue, speakers, or sounds that are not supported by the audio. Mark inaudible or uncertain sections clearly.",
    "REQUIRED OUTPUT QUALITY:",
    "- Transcribe speech with timestamps when possible; quote exact words; mark [inaudible] / [unclear] rather than guessing.",
    "- Note speakers if distinguishable (Speaker A/B or role cues), language, and delivery/tone.",
    "- Describe non-speech audio: music, sound effects, ambience, crowd noise, silence, abrupt cuts.",
    "Use this exact format:",
    meta
      ? `Audio summary: 2-4 sentences on what is heard in this window (${rangeLabel}), including speech gist and notable non-speech sound.`
      : "Audio summary: 2-4 sentences covering speech gist, speakers, and notable non-speech sound.",
    "Transcript:",
    "- Timestamped lines for speech (e.g. 0:12 Speaker A: \"...\").",
    "- Write 'none' if there is no intelligible speech.",
    "Speakers: who is heard, how they relate if clear; otherwise 'undetermined'.",
    "Non-speech: music, SFX, ambience, tone, silence — with timestamps when useful.",
    "Language: detected language(s), or 'undetermined'.",
    sequential ? "Carry-forward: 2-3 sentences for the next window's analyst — active speakers, ongoing music/noise, unresolved speech." : "",
    "Uncertainty: brief notes on muffled audio, overlapping speech, or likely missed content.",
    "",
    previousSummary ? `Previous window continuity notes (${previousSummary.rangeLabel}):\n${String(previousSummary.summary || "").trim() || "(no notes)"}` : "",
    formatMediaPostContext(target, context, { includeQuestion: options.includeQuestion !== false }),
    "",
    `Audio window: ${rangeLabel}`,
    "Video metadata:",
    JSON.stringify(describeMediaForModel(target), null, 2)
  ].filter(Boolean).join("\n");
}

export function buildAudioMergePrompt({
  requestPrompt,
  target,
  context,
  sections,
  chunkCount,
  failedChunkCount
}) {
  return [
    "Merge the following per-window audio analyses into one coherent audio evidence report for AskLocal.",
    "This is a text-only merge: you will not hear the audio again. Do not invent speech or sounds absent from the window notes.",
    requestPrompt ? `User/model focus: ${requestPrompt}` : "",
    "Unify speakers across windows when continuity is clear. Keep absolute timestamps. Prefer exact quoted transcript lines from the window notes.",
    "Use this format:",
    "Audio summary: 3-6 sentences covering the whole clip.",
    "Transcript: unified timestamped transcript.",
    "Speakers: recurring speakers and roles.",
    "Non-speech: music/SFX/ambience timeline.",
    "Language: detected language(s).",
    "Uncertainty: remaining gaps.",
    "",
    formatMediaPostContext(target, context, { includeQuestion: true }),
    "",
    `Windows analyzed: ${chunkCount}${failedChunkCount ? ` (${failedChunkCount} failed)` : ""}`,
    "Window notes:",
    sections.join("\n\n")
  ].filter(Boolean).join("\n");
}

export function compactAudioCarryForward(section, maxChars = MEDIA_ANALYSIS_CARRY_FORWARD_CHARS) {
  const text = String(section || "").trim();
  if (!text) return "";
  const cap = clampNumber(maxChars, 200, 4000, MEDIA_ANALYSIS_CARRY_FORWARD_CHARS);
  const carry = text.match(/Carry-forward:\s*([\s\S]*?)(?=\n(?:Uncertainty:|$))/i)?.[1]?.trim();
  if (carry) return carry.slice(0, cap);
  const summary = text.match(/Audio summary:\s*([\s\S]*?)(?=\n(?:Transcript:|$))/i)?.[1]?.trim();
  if (summary) return summary.slice(0, cap);
  return text.slice(0, cap);
}

async function runWithConcurrency(total, concurrency, worker) {
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

export function formatAnalysisAudioLabel(chunk, index) {
  const range = chunk.rangeLabel || [
    formatSeconds(chunk.startSeconds),
    formatSeconds(chunk.endSeconds)
  ].filter(Boolean).join("-");
  return `Audio ${index + 1}${range ? ` (${range})` : ""}: ${chunk.label || "video audio chunk"}`;
}
