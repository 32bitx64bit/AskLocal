import { api } from "../api.js";
import {
  DONT_RETRY_HINT,
  MAX_MEDIA_DATA_URL_BYTES,
  MAX_MEDIA_IMAGE_BYTES,
  MEDIA_ANALYSIS_CHUNK_HEARTBEAT_MS,
  MEDIA_IMAGE_CACHE_LIMIT
} from "../constants.js";
import {
  isAllowedHttpUrl
} from "../../lib/url.js";
import {
  arrayBufferToBase64,
  formatSeconds,
  runWithProgressHeartbeat
} from "../../lib/utils.js";
import {
  MEDIA_IMAGE_CACHE,
  buildImageDataCacheKey,
  buildMediaAnalysisCacheKey,
  findExistingMediaAnalysis,
  readCachedMediaAnalysis,
  rememberLimitedCache,
  writeCachedMediaAnalysis
} from "../media/cache.js";
import {
  callOpenAICompatibleAudioAnalysis,
  callOpenAICompatibleMediaAnalysis
} from "../providers/openai-compatible.js";
import {
  getMediaModel
} from "../settings.js";
import {
  buildInspectableItems,
  compactMediaRef,
  resolveInspectableMediaTarget,
  summarizeMediaTarget
} from "../tools/inspectables.js";

export async function analyzeImageTool(args, context, settings) {
  if (!settings.allowImageAnalysis) {
    return { ok: false, tool: "analyze_image", error: "Image analysis is disabled in AskLocal settings." };
  }

  const target = resolveInspectableMediaTarget(args, context, "image");
  if (!target) {
    const available = buildInspectableItems(context);
    return {
      ok: false,
      tool: "analyze_image",
      error: `Could not resolve the requested image. ${DONT_RETRY_HINT}`,
      availableImages: available.media.filter((item) => item.mediaType === "image").slice(0, 12).map(compactMediaRef)
    };
  }

  const existing = findExistingMediaAnalysis(context, target, "image");
  if (existing) {
    // The full analysis is already in the prompt or an earlier tool result;
    // returning it again would only duplicate those tokens.
    return {
      ok: true,
      tool: "analyze_image",
      type: "image",
      cached: true,
      reusedFromContext: true,
      target: existing.target,
      summary: String(existing.analysis || "").replace(/\s+/g, " ").trim().slice(0, 280)
    };
  }

  const providerSettings = resolveMediaProviderSettings(settings, "image");
  const cacheKey = buildMediaAnalysisCacheKey("image", target, context, args, providerSettings);
  const cached = await readCachedMediaAnalysis(cacheKey);
  if (cached) {
    context.mediaAnalyses.push(cached);
    return cached;
  }

  const image = await loadImageForAnalysis(target, context);
  if (!image.ok) {
    return {
      ok: false,
      tool: "analyze_image",
      target: summarizeMediaTarget(target),
      error: image.error
    };
  }

  const prompt = buildImageAnalysisPrompt(args.prompt, target, context, {
    includeQuestion: !args.automatic
  });
  await context.reportProgress?.("Analyzing image...");
  const analysisText = await runWithProgressHeartbeat(
    () => callMediaAnalysisProvider(providerSettings, {
      kind: "image",
      prompt,
      images: [image],
      target,
      signal: context.abortSignal
    }),
    {
      reportProgress: context.reportProgress,
      label: (seconds) => (seconds ? `Still analyzing image — ${seconds}s...` : "Still analyzing image..."),
      heartbeatMs: MEDIA_ANALYSIS_CHUNK_HEARTBEAT_MS,
      signal: context.abortSignal
    }
  );

  const result = {
    ok: true,
    tool: "analyze_image",
    type: "image",
    target: summarizeMediaTarget(target),
    model: `${providerSettings.provider}:${providerSettings.model}`,
    analysis: analysisText
  };
  await writeCachedMediaAnalysis(cacheKey, result, context.mediaSessionId);
  context.mediaAnalyses.push(result);
  return result;
}
export async function loadImageForAnalysis(target, context) {
  const url = target.imageUrl || target.url || target.posterUrl;
  if (!url) return { ok: false, error: "The image did not have a readable URL." };
  const mediaSessionId = String(context?.mediaSessionId || "").trim();
  const cacheKey = buildImageDataCacheKey(target, context);
  const cached = MEDIA_IMAGE_CACHE.get(cacheKey);
  if (cached) {
    rememberLimitedCache(MEDIA_IMAGE_CACHE, cacheKey, cached, MEDIA_IMAGE_CACHE_LIMIT, cached.sessionId || mediaSessionId);
    const { sessionId, ...value } = cached;
    return { ...value, cached: true };
  }

  const loaded = await fetchMediaImageAsDataUrl(url, {
    label: target.altText || target.label || "image",
    sourceUrl: target.url || url
  });
  if (loaded.ok) {
    rememberLimitedCache(MEDIA_IMAGE_CACHE, cacheKey, { ...loaded, cached: false, sessionId: mediaSessionId }, MEDIA_IMAGE_CACHE_LIMIT, mediaSessionId);
  }
  return loaded;
}
export async function fetchMediaImageAsDataUrl(url, meta = {}) {
  const raw = String(url || "").trim();
  if (!raw) return { ok: false, error: "Image URL was empty." };

  if (raw.startsWith("data:image/")) {
    if (raw.length > MAX_MEDIA_DATA_URL_BYTES) {
      return { ok: false, error: "In-memory image capture was too large." };
    }
    return {
      ok: true,
      dataUrl: raw,
      mimeType: extractDataUrlMimeType(raw) || "image/jpeg",
      label: meta.label || "image",
      sourceUrl: meta.sourceUrl || ""
    };
  }

  if (!isAllowedHttpUrl(raw)) {
    return { ok: false, error: "Only http(s) and data:image URLs can be analyzed." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(raw, {
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.3" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Image request failed: ${response.status}`);

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_MEDIA_IMAGE_BYTES) throw new Error("Image was too large to analyze.");

    const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim() || "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`URL did not return an image (${contentType}).`);
    }

    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error("Image response was empty.");
    if (buffer.byteLength > MAX_MEDIA_IMAGE_BYTES) throw new Error("Image was too large to analyze.");

    return {
      ok: true,
      dataUrl: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
      mimeType: contentType,
      label: meta.label || "image",
      sourceUrl: meta.sourceUrl || raw
    };
  } catch (error) {
    return { ok: false, error: error.message || "Could not fetch image." };
  } finally {
    clearTimeout(timeout);
  }
}
export function normalizeAnalysisImage(image) {
  if (!image?.dataUrl || !String(image.dataUrl).startsWith("data:image/")) {
    return { ok: false, error: "Frame did not contain image data." };
  }
  if (String(image.dataUrl).length > MAX_MEDIA_DATA_URL_BYTES) {
    return { ok: false, error: "Frame image was too large." };
  }
  return {
    ok: true,
    dataUrl: String(image.dataUrl),
    mimeType: image.mimeType || extractDataUrlMimeType(image.dataUrl) || "image/jpeg",
    label: String(image.label || "frame").slice(0, 80),
    sourceUrl: String(image.sourceUrl || ""),
    timestampSeconds: Number.isFinite(Number(image.timestampSeconds)) ? Number(image.timestampSeconds) : null,
    timestamp: String(image.timestamp || "")
  };
}
export function extractDataUrlMimeType(dataUrl) {
  return String(dataUrl || "").match(/^data:([^;,]+);base64,/i)?.[1] || "";
}
export function buildImageAnalysisPrompt(requestPrompt, target, context, options = {}) {
  const includeQuestion = options.includeQuestion !== false;
  return [
    "Analyze the provided image for AskLocal as factual visual evidence for another model.",
    requestPrompt ? `User/model focus: ${requestPrompt}` : "",
    "Do not answer the user directly unless the focus explicitly asks for it. Describe only what is visible or strongly implied by visible context. Never invent people, text, logos, or off-image events.",
    "Prioritize concrete details that help evaluate claims: subject, actions, setting, layout, relationships, screenshot/UI context, meme/chart/document structure, symbols/logos, and notable visual cues.",
    "Transcribe readable on-screen text exactly when it matters; mark partial/uncertain OCR. Do not invent missing words.",
    "If this is a screenshot, separate page/app content from browser/UI chrome when relevant.",
    "Call out uncertainty. Avoid identifying private people unless the image or metadata clearly identifies them.",
    "Keep the output compact and scannable. Avoid boilerplate and long raw OCR dumps unless the image is mostly text.",
    "Use this format:",
    "Summary: one sentence with the main visual point / claim-relevant content.",
    "Key visual details: 2-6 bullets with the most relevant objects, people, setting, actions, layout, and cues.",
    "Readable text: exact visible text that matters, grouped by location; write 'none' if there is no readable text.",
    "Context/uncertainty: brief notes about ambiguity, missing context, or likely interpretation vs. fact.",
    "",
    formatMediaPostContext(target, context, { includeQuestion }),
    "",
    "Image metadata:",
    JSON.stringify(summarizeMediaTarget(target), null, 2)
  ].filter(Boolean).join("\n");
}

/** Post/question context for vision models so they know what the clip/image is attached to. */
export function formatMediaPostContext(target, context, options = {}) {
  const includeQuestion = options.includeQuestion !== false;
  const compact = Boolean(options.compact);
  const tweet = context?.currentTweet || null;
  const quoted = context?.quotedTweet || null;
  const handle = String(target?.authorHandle || tweet?.authorHandle || "").replace(/^@/, "");
  const postText = String(target?.postText || tweet?.text || "").trim();
  const postCap = compact ? 320 : 900;
  const questionCap = compact ? 220 : 500;
  const lines = compact
    ? ["Post (orientation only):"]
    : ["Post context (for orientation only — still describe what is visible):"];

  if (handle || postText) {
    lines.push(`@${handle || "unknown"}: ${postText || "(no post text)"}`.slice(0, postCap));
  } else {
    lines.push("(no surrounding post text was available)");
  }

  if (quoted?.text && !compact) {
    const quotedHandle = String(quoted.authorHandle || "").replace(/^@/, "") || "unknown";
    lines.push(`Quoted @${quotedHandle}: ${String(quoted.text).trim()}`.slice(0, 500));
  } else if (quoted?.text && compact) {
    const quotedHandle = String(quoted.authorHandle || "").replace(/^@/, "") || "unknown";
    lines.push(`Quoted @${quotedHandle}: ${String(quoted.text).trim()}`.slice(0, 160));
  }

  const question = String(context?.originalQuestion || "").trim();
  if (includeQuestion && question) {
    lines.push(`User question (focus only — do not answer): ${question}`.slice(0, questionCap));
  } else if (question && !compact) {
    lines.push(`User question for focus only (do not answer it): ${question}`.slice(0, questionCap));
  }

  return lines.join("\n");
}
export function formatAnalysisImageLabel(image, index) {
  const timestamp = image.timestamp || formatSeconds(image.timestampSeconds);
  const label = image.label || (timestamp ? "sampled video frame" : "image");
  return `Image ${index + 1}${timestamp ? ` at ${timestamp}` : ""}: ${label}`;
}
export function formatInlineImageLabel(image, index) {
  const target = image.target ?? {};
  const details = [
    target.contextId ? `context ${target.contextId}` : "",
    target.postUrl ? `post ${target.postUrl}` : "",
    target.altText ? `alt text: ${target.altText}` : ""
  ].filter(Boolean).join("; ");
  return `Selected tweet image ${index + 1}${details ? ` (${details})` : ""}. Use this image as primary context when it is relevant to the user's question.`;
}
export function resolveMediaProviderSettings(settings, kind) {
  const selected = getMediaModel(settings, kind);
  if (!selected?.model) {
    const label = kind === "videoMerge"
      ? "Video merge"
      : (kind === "video" ? "Video" : (kind === "audio" ? "Audio" : "Image"));
    throw new Error(`${label} model is required.`);
  }
  return {
    provider: selected.provider,
    endpoint: selected.endpoint,
    model: selected.model,
    apiKey: selected.apiKey || ""
  };
}
export function describeMediaProvider(settings, kind) {
  const selected = getMediaModel(settings, kind);
  if (!selected) return "not configured";
  const prefix = kind === "videoMerge"
    ? "videoMerge"
    : (kind === "video" ? "video" : (kind === "audio" ? "audio" : "image"));
  const useMain = !String(settings?.[`${prefix}ModelId`] || "").trim() || settings?.[`${prefix}UseBaseProvider`];
  const label = selected.name || selected.model || "model";
  return useMain ? `main:${label}` : label;
}
export async function callMediaAnalysisProvider(providerSettings, request) {
  return callOpenAICompatibleMediaAnalysis(providerSettings, request);
}
export async function callAudioAnalysisProvider(providerSettings, request) {
  return callOpenAICompatibleAudioAnalysis(providerSettings, request);
}

