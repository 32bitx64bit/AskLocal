/**
 * Stable identity for a piece of X media, independent of the post it appears on.
 *
 * The same photo or clip shows up on its original post, in reposts, in quotes and when
 * someone re-posts the video into their own post. X serves it from the same pbs/video
 * path every time, so that path (not the post id) is what analyses are cached under:
 * analyzing a video once makes every other post carrying it a cache hit.
 *
 * Pure: no browser APIs.
 */

const VIDEO_PATH_RE = /\/(?:amplify_video|ext_tw_video|tweet_video|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\/([^/?#.]+)/;
const IMAGE_PATH_RE = /\/(?:media|card_img)\/([^/?#.]+)/;

function pathMatch(value, re) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)twimg\.com$/i.test(url.hostname)) return "";
    return url.pathname.match(re)?.[1] || "";
  } catch {
    return "";
  }
}

function urlsOf(target) {
  return [
    target?.posterUrl,
    target?.srcUrl,
    target?.imageUrl,
    target?.url,
    ...(Array.isArray(target?.rawVideoUrls) ? target.rawVideoUrls : [])
  ].filter(Boolean);
}

/**
 * "x-video:1234", "x-image:GxAbC", or "" when the media has nothing post-independent
 * to key on (then callers fall back to a post-scoped key and simply don't share).
 */
export function mediaIdentity(target) {
  if (!target) return "";
  const type = String(target.mediaType || target.type || "").toLowerCase();
  if (type === "video") {
    for (const url of urlsOf(target)) {
      const id = pathMatch(url, VIDEO_PATH_RE);
      if (id) return `x-video:${id}`;
    }
    const mediaId = String(target.mediaId || "").trim();
    return mediaId ? `x-video:${mediaId}` : "";
  }
  if (type === "image") {
    for (const url of urlsOf(target)) {
      const id = pathMatch(url, IMAGE_PATH_RE);
      if (id) return `x-image:${id}`;
    }
    const mediaId = String(target.mediaId || "").trim();
    return mediaId ? `x-image:${mediaId}` : "";
  }
  return "";
}

/** Identity when there is one, otherwise a key scoped to the post the media is on. */
export function mediaCacheIdentity(target) {
  const shared = mediaIdentity(target);
  if (shared) return shared;
  const type = String(target?.mediaType || target?.type || "media");
  const post = String(target?.statusId || target?.contextId || "").trim();
  const index = Number.isFinite(Number(target?.sequenceIndex)) ? Number(target.sequenceIndex) : 0;
  return post ? `post-${type}:${post}:${index}` : `${type}:${String(target?.id || "")}`;
}
