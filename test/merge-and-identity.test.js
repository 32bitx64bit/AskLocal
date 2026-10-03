import "./helpers/browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeContextTweet } from "../src/background/ask/context.js";
import { mediaCacheIdentity, mediaIdentity } from "../src/background/media/identity.js";
import { buildMediaAnalysisCacheKey } from "../src/background/media/cache.js";

test("an empty API author never erases the handle read from the page", () => {
  const dom = { statusId: "1", authorHandle: "alice", displayName: "Alice", url: "https://x.com/alice/status/1", text: "hi" };
  const api = { statusId: "1", authorHandle: "", displayName: "", url: "https://x.com/i/web/status/1", text: "hi there", engagement: "3 likes" };
  const merged = mergeContextTweet(dom, api);
  assert.equal(merged.authorHandle, "alice");
  assert.equal(merged.displayName, "Alice");
  assert.equal(merged.url, "https://x.com/alice/status/1");
  assert.equal(merged.text, "hi there");
  assert.equal(merged.engagement, "3 likes");
});

test("the API's author wins when it has one", () => {
  const merged = mergeContextTweet({ authorHandle: "wrong" }, { authorHandle: "right", url: "https://x.com/right/status/2" });
  assert.equal(merged.authorHandle, "right");
});

test("the same video on different posts has one identity", () => {
  const onOriginal = { mediaType: "video", statusId: "100", posterUrl: "https://pbs.twimg.com/amplify_video_thumb/777/img/a.jpg" };
  const onRepost = { mediaType: "video", statusId: "200", srcUrl: "https://video.twimg.com/amplify_video/777/vid/avc1/1280x720/b.mp4" };
  assert.equal(mediaIdentity(onOriginal), "x-video:777");
  assert.equal(mediaIdentity(onRepost), "x-video:777");
});

test("image identity ignores size/format query and post", () => {
  const a = { mediaType: "image", statusId: "1", url: "https://pbs.twimg.com/media/GxAbC?format=jpg&name=small" };
  const b = { mediaType: "image", statusId: "2", imageUrl: "https://pbs.twimg.com/media/GxAbC.jpg?name=large" };
  assert.equal(mediaIdentity(a), mediaIdentity(b));
});

test("media without a shareable identity falls back to a post-scoped key", () => {
  assert.equal(mediaCacheIdentity({ mediaType: "image", statusId: "9", sequenceIndex: 1, url: "data:image/png;base64,AAA" }), "post-image:9:1");
});

test("analysis cache keys are shared across posts and sessions for automatic analysis", () => {
  const provider = { provider: "openai-compatible", endpoint: "https://api.example/v1", model: "m" };
  const first = buildMediaAnalysisCacheKey("video", { mediaType: "video", statusId: "100", mediaId: "777" }, { mediaSessionId: "s1", originalQuestion: "is this real?" }, { automatic: true }, provider);
  const second = buildMediaAnalysisCacheKey("video", { mediaType: "video", statusId: "200", mediaId: "777" }, { mediaSessionId: "s2", originalQuestion: "explain" }, { automatic: true }, provider);
  assert.equal(first, second);
  const focused = buildMediaAnalysisCacheKey("video", { mediaType: "video", mediaId: "777" }, { originalQuestion: "who speaks at 0:30?" }, { prompt: "speaker" }, provider);
  assert.notEqual(first, focused);
});
