/**
 * The one place that knows where X keeps things in its GraphQL JSON.
 *
 * X moves fields around without notice (in 2025 a user's screen_name and name moved
 * from `user.legacy` to `user.core`; reading only the old path silently produced posts
 * with no author). Every accessor here reads the current path first and the older ones
 * after, so the rest of the extension never touches raw paths and a format change is
 * fixed in this file alone. Pure: no browser APIs, so it runs under `node --test`.
 */

const MAX_UNWRAP_DEPTH = 6;

/** Follow X's wrappers (`tweet_results.result`, `TweetWithVisibilityResults.tweet`, …) to the post object. */
export function unwrapTweet(result) {
  let node = result;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (!node || typeof node !== "object") return null;
    if (node.__typename === "TweetTombstone" || node.tombstone) return null;
    if (node.legacy || node.rest_id) return node;
    node = node.tweet_results?.result ?? node.result ?? node.tweet ?? null;
  }
  return node && typeof node === "object" ? node : null;
}

/** The user object (`User`) behind a `user_results` wrapper, or null for UserUnavailable / missing. */
export function unwrapUser(userResults) {
  const node = userResults?.result ?? userResults;
  if (!node || typeof node !== "object") return null;
  if (node.__typename === "UserUnavailable") return null;
  return node;
}

/**
 * { id, handle, name, verified } for a User object. Handle and name live in `core`
 * on current X, in `legacy` on older responses; both are read.
 */
export function readUser(user) {
  if (!user || typeof user !== "object") return { id: "", handle: "", name: "", verified: false };
  const handle = String(user.core?.screen_name ?? user.legacy?.screen_name ?? user.screen_name ?? "").replace(/^@/, "").trim();
  const name = String(user.core?.name ?? user.legacy?.name ?? user.name ?? "").trim();
  return {
    id: String(user.rest_id ?? user.id_str ?? user.legacy?.id_str ?? "").trim(),
    handle,
    name,
    verified: Boolean(user.is_blue_verified ?? user.verification?.verified ?? user.legacy?.verified)
  };
}

/** Author of a post object. */
export function readTweetAuthor(tweet) {
  return readUser(unwrapUser(tweet?.core?.user_results));
}

/** The original post inside a repost, or null when `tweet` is not a repost. */
export function readRepostedTweet(tweet) {
  const legacy = tweet?.legacy ?? {};
  return unwrapTweet(legacy.retweeted_status_result?.result ?? tweet?.retweeted_status_result?.result ?? null);
}

/** The quoted post object, or null. */
export function readQuotedTweet(tweet) {
  return unwrapTweet(tweet?.quoted_status_result?.result ?? null);
}

/** Long-form ("note") text and its entity set, when the post has one. */
export function readNoteTweet(tweet) {
  const note = tweet?.note_tweet?.note_tweet_results?.result ?? tweet?.note_tweet_results?.result ?? null;
  return note && typeof note.text === "string" ? note : null;
}

/** Status id of a post object. */
export function readTweetId(tweet) {
  return String(tweet?.legacy?.id_str ?? tweet?.rest_id ?? "").trim();
}

/**
 * Who first posted a media item that this post reuses (X's "video from @x" when someone
 * reposts a clip into their own post). Empty when the media is the post author's own.
 */
export function readMediaSource(mediaEntity) {
  const sourceStatusId = String(mediaEntity?.source_status_id_str ?? "").trim();
  const sourceUserId = String(mediaEntity?.source_user_id_str ?? "").trim();
  const user = readUser(unwrapUser(mediaEntity?.additional_media_info?.source_user?.user_results));
  return {
    sourceStatusId,
    sourceUserId: sourceUserId || user.id,
    sourceHandle: user.handle,
    sourceName: user.name
  };
}

/** X's own stable media key ("3_1234…", "7_1234…") and numeric id. */
export function readMediaKeys(mediaEntity) {
  return {
    mediaKey: String(mediaEntity?.media_key ?? "").trim(),
    mediaId: String(mediaEntity?.id_str ?? mediaEntity?.id ?? "").trim()
  };
}
