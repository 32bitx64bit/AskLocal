import "./helpers/browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { photoEntity, tweet, tweetDetail, user, videoEntity } from "./helpers/x-fixtures.js";
import { collectTweetsFromTweetDetail, collectTweetsFromXObject, normalizeXTweetResult } from "../src/background/x/parse.js";
import { assembleXPostContext } from "../src/background/x/collect.js";
import { buildConversation, renderConversation } from "../src/background/prompt/thread.js";
import { readUser } from "../src/background/x/schema.js";

test("handles come from user.core (current X) and user.legacy (older responses)", () => {
  assert.equal(readUser(user("alice")).handle, "alice");
  assert.equal(readUser(user("bob", { legacyOnly: true })).handle, "bob");
  const post = normalizeXTweetResult(tweet({ author: user("alice"), text: "hello" }));
  assert.equal(post.authorHandle, "alice");
  assert.match(post.url, /^https:\/\/x\.com\/alice\/status\/\d+$/);
});

test("a repost is credited to the original author, with the reposter kept aside", () => {
  const original = tweet({ author: user("alice"), text: "original words" });
  const repost = tweet({ author: user("bob"), text: "RT @alice: original words", reposted: original });
  const post = normalizeXTweetResult(repost);
  assert.equal(post.authorHandle, "alice");
  assert.equal(post.statusId, original.rest_id);
  assert.equal(post.repostedBy, "bob");
  assert.equal(post.text, "original words");
});

test("search-style walks credit reposts to the original author", () => {
  const original = tweet({ author: user("alice"), text: "claim" });
  const repost = tweet({ author: user("bob"), text: "RT @alice: claim", reposted: original });
  const posts = collectTweetsFromXObject({ data: { search: { items: [{ tweet_results: { result: repost } }] } } });
  assert.ok(posts.length >= 1);
  for (const post of posts) assert.equal(post.authorHandle, "alice");
});

test("a quote inside a repost belongs to the reposted post", () => {
  const quoted = tweet({ author: user("carol"), text: "quoted" });
  const original = tweet({ author: user("alice"), text: "look", quoted });
  const repost = tweet({ author: user("bob"), text: "RT @alice: look", reposted: original });
  const posts = collectTweetsFromTweetDetail(tweetDetail({ focal: repost }), { focalStatusId: repost.rest_id });
  const quote = posts.find((post) => post.sourceRole === "quoted_post");
  assert.equal(quote.authorHandle, "carol");
  assert.equal(quote.quotedByStatusId, original.rest_id);
});

test("re-posted media credits who first posted it", () => {
  const alice = user("alice");
  const media = videoEntity("555", { sourceStatusId: "1", sourceUser: alice });
  const post = normalizeXTweetResult(tweet({ author: user("bob"), text: "lol", media: [media] }));
  assert.equal(post.media[0].sourceHandle, "alice");
  assert.equal(post.media[0].sourceStatusId, "1");
  assert.equal(post.media[0].mediaKey, "13_555");
  assert.equal(post.media[0].durationMs, 42000);
});

test("thread tree keeps every author on the right post when a reply is selected", () => {
  const alice = user("alice");
  const carol = user("carol");
  const dave = user("dave");
  const root = tweet({ author: alice, text: "Root claim with a clip", media: [videoEntity("777")] });
  const ref = { statusId: root.rest_id, handle: "alice", conversationId: root.rest_id };
  const selected = tweet({ author: carol, text: "That clip is edited", replyTo: ref });
  const underSelected = tweet({
    author: dave,
    text: "No it isn't",
    replyTo: { statusId: selected.rest_id, handle: "carol", conversationId: root.rest_id }
  });
  const page = tweetDetail({ ancestors: [root], focal: selected, replies: [underSelected] });
  const x = assembleXPostContext({ pages: [page], statusId: selected.rest_id });
  assert.ok(x.ok);

  const conversation = buildConversation({ selected: x.root, quoted: x.quoted, thread: x });
  const text = renderConversation(conversation, { caps: { topLiked: 8, parents: 8, rootReplies: 8, tweetChars: 600, currentChars: 1500 } });
  const lineFor = (needle) => text.split("\n").find((line) => line.includes(needle)) ?? "";

  assert.match(lineFor("Root claim"), /@alice/);
  assert.match(lineFor("That clip is edited"), /@carol/);
  assert.match(lineFor("That clip is edited"), /★ SELECTED/);
  assert.match(lineFor("No it isn't"), /@dave/);
  assert.match(lineFor("No it isn't"), /replying to @carol/);
  assert.doesNotMatch(text, /unknown author/);
});

test("photo-only posts keep their author", () => {
  const post = normalizeXTweetResult(tweet({ author: user("erin"), text: "https://t.co/pic", media: [photoEntity("9", "GxAbC")] }));
  assert.equal(post.authorHandle, "erin");
  assert.equal(post.text, "");
  assert.equal(post.media[0].mediaType, "image");
});
