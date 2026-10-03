// Builders for X GraphQL objects in the current (2025+) shape: a user's handle and name
// live in `core`, not `legacy`. Real captured responses (Settings → Diagnostics →
// export) should replace these over time; the builders keep the tests readable.

let nextId = 1000;
export const id = () => String(nextId += 1);

export function user(handle, { name = handle, legacyOnly = false } = {}) {
  const restId = id();
  return legacyOnly
    ? { __typename: "User", rest_id: restId, legacy: { screen_name: handle, name } }
    : { __typename: "User", rest_id: restId, core: { screen_name: handle, name, created_at: "Mon Jan 01 00:00:00 +0000 2018" }, legacy: { followers_count: 10 } };
}

export function tweet({ statusId = id(), author, text = "", replyTo = null, conversationId = null, media = [], quoted = null, reposted = null, likes = 0 }) {
  return {
    __typename: "Tweet",
    rest_id: statusId,
    core: { user_results: { result: author } },
    legacy: {
      id_str: statusId,
      full_text: text,
      created_at: "Wed Oct 01 12:00:00 +0000 2025",
      conversation_id_str: conversationId ?? replyTo?.conversationId ?? statusId,
      in_reply_to_status_id_str: replyTo?.statusId ?? undefined,
      in_reply_to_screen_name: replyTo?.handle ?? undefined,
      favorite_count: likes,
      entities: { urls: [], media },
      extended_entities: media.length ? { media } : undefined,
      quoted_status_id_str: quoted ? quoted.rest_id : undefined,
      retweeted_status_result: reposted ? { result: reposted } : undefined
    },
    quoted_status_result: quoted ? { result: quoted } : undefined
  };
}

export function videoEntity(mediaId, { sourceStatusId = "", sourceUser = null } = {}) {
  return {
    id_str: mediaId,
    media_key: `13_${mediaId}`,
    type: "video",
    media_url_https: `https://pbs.twimg.com/amplify_video_thumb/${mediaId}/img/abc.jpg`,
    url: "https://t.co/vid",
    source_status_id_str: sourceStatusId || undefined,
    additional_media_info: sourceUser ? { source_user: { user_results: { result: sourceUser } } } : undefined,
    video_info: {
      duration_millis: 42000,
      variants: [
        { content_type: "video/mp4", bitrate: 832000, url: `https://video.twimg.com/amplify_video/${mediaId}/vid/avc1/640x360/x.mp4` }
      ]
    }
  };
}

export function photoEntity(mediaId, name) {
  return {
    id_str: mediaId,
    media_key: `3_${mediaId}`,
    type: "photo",
    media_url_https: `https://pbs.twimg.com/media/${name}.jpg`,
    url: "https://t.co/pic"
  };
}

/** A TweetDetail response: entries in X's order (ancestors, focal, conversation threads). */
export function tweetDetail({ ancestors = [], focal, replies = [] }) {
  const entry = (t, entryId) => ({ entryId, content: { itemContent: { tweet_results: { result: t } } } });
  const entries = [
    ...ancestors.map((t) => entry(t, `tweet-${t.rest_id}`)),
    entry(focal, `tweet-${focal.rest_id}`),
    ...replies.map((t) => ({
      entryId: `conversationthread-${t.rest_id}`,
      content: { items: [{ item: { itemContent: { tweet_results: { result: t } } } }] }
    }))
  ];
  return { data: { threaded_conversation_with_injections_v2: { instructions: [{ type: "TimelineAddEntries", entries }] } } };
}
