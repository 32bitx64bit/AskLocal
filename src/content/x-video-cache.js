import { api } from "./api.js";
import {
  state
} from "./state.js";
import {
  extractTweetVideoMediaId,
  heightFromTweetVideoUrl,
  isPlayableTweetAudioUrl,
  isPlayableTweetVideoUrl,
  normalizeMediaUrlForContext,
  normalizeResourceVideoIdentity,
  scoreTweetVideoCandidate,
  widthFromTweetVideoUrl
} from "./tweet-media.js";

export function handleXMediaSnifferMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (data?.source !== "asklocal:x-media" || data.type !== "video-variants") return;
  mergeXVideoCandidates(data.candidates);
}
export function requestXMediaSnifferCache() {
  try {
    window.postMessage({ source: "asklocal:content", type: "request-video-cache" }, "*");
  } catch {
    // Best-effort; future X API responses will still be pushed by the sniffer.
  }
}
export function mergeXVideoCandidates(candidates) {
  if (!Array.isArray(candidates)) return;
  for (const candidate of candidates) {
    const url = normalizeMediaUrlForContext(candidate?.url);
    const kind = String(candidate?.kind || "").toLowerCase() === "audio" || isPlayableTweetAudioUrl(url)
      ? "audio"
      : "video";
    if (kind === "audio") {
      if (!isPlayableTweetAudioUrl(url)) continue;
      const key = normalizeResourceVideoIdentity(url);
      if (state.xAudioCandidates.some((item) => item.key === key)) continue;
      state.xAudioCandidates.push({
        key,
        url,
        statusId: String(candidate.statusId || ""),
        mediaId: String(candidate.mediaId || extractTweetVideoMediaId(url) || ""),
        bitrate: Number(candidate.bitrate || 0) || 0
      });
      continue;
    }
    if (!isPlayableTweetVideoUrl(url)) continue;
    const key = normalizeResourceVideoIdentity(url);
    if (state.xVideoCandidates.some((item) => item.key === key)) continue;
    state.xVideoCandidates.push({
      key,
      url,
      statusId: String(candidate.statusId || ""),
      mediaId: String(candidate.mediaId || extractTweetVideoMediaId(url) || ""),
      bitrate: Number(candidate.bitrate || 0) || 0,
      width: Number(candidate.width || 0) || widthFromTweetVideoUrl(url),
      height: Number(candidate.height || 0) || heightFromTweetVideoUrl(url)
    });
  }
  if (state.xVideoCandidates.length > 300) {
    state.xVideoCandidates.splice(0, state.xVideoCandidates.length - 300);
  }
  if (state.xAudioCandidates.length > 120) {
    state.xAudioCandidates.splice(0, state.xAudioCandidates.length - 120);
  }
}
export function getCachedTweetVideoUrls(meta = {}) {
  if (!state.xVideoCandidates.length) return [];
  const statusId = String(meta.statusId || "");
  const mediaId = String(meta.mediaId || "");
  let matches = state.xVideoCandidates;
  if (mediaId) matches = matches.filter((candidate) => candidate.mediaId === mediaId || candidate.url.includes(`/${mediaId}/`));
  if (!matches.length && statusId) matches = state.xVideoCandidates.filter((candidate) => candidate.statusId === statusId);
  if (!matches.length) return [];
  return matches
    .slice()
    .sort((left, right) => scoreTweetVideoCandidate(right) - scoreTweetVideoCandidate(left))
    .map((candidate) => candidate.url);
}
export function getCachedTweetAudioUrls(meta = {}) {
  if (!state.xAudioCandidates.length) return [];
  const statusId = String(meta.statusId || "");
  const mediaId = String(meta.mediaId || "");
  let matches = state.xAudioCandidates;
  if (mediaId) matches = matches.filter((candidate) => candidate.mediaId === mediaId || candidate.url.includes(`/${mediaId}/`));
  if (!matches.length && statusId) matches = state.xAudioCandidates.filter((candidate) => candidate.statusId === statusId);
  if (!matches.length) return [];
  return matches
    .slice()
    .sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))
    .map((candidate) => candidate.url);
}

