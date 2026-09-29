import { api } from "./api.js";

export const ASKLOCAL_VERSION = api.runtime.getManifest().version;
export const OPENAI_TOOL_CALL_LIMIT = 6;
/** Default model context window (tokens) when the user has not set one. */
export const DEFAULT_MODEL_CONTEXT_TOKENS = 32768;
export const MIN_MODEL_CONTEXT_TOKENS = 2048;
export const MAX_MODEL_CONTEXT_TOKENS = 262144;
/** Default sampling temperature for answers; low values keep answers close to the sources. */
export const DEFAULT_TEMPERATURE = 0.3;
export const SETTINGS_STORE_KEY = "asklocalSettings";
export const CHAT_INDEX_KEY = "asklocalChatIndex";
export const CHAT_RECORD_PREFIX = "asklocalChat:";
export const CHAT_HISTORY_LIMIT = 200;
export const MEDIA_CACHE_PREFIX = "asklocalMediaCache:";
export const MEDIA_ANALYSIS_STORAGE_KEY = "asklocalMediaAnalysisCache";
export const MEDIA_ANALYSIS_CACHE_LIMIT = 80;
/** Cross-chat processed video/audio analyses, owned by the first chat that produced them. */
export const POST_MEDIA_ANALYSIS_STORAGE_KEY = "asklocalPostMediaAnalysisCache";
export const POST_MEDIA_ANALYSIS_CACHE_LIMIT = 40;
export const MEDIA_IMAGE_CACHE_LIMIT = 24;
export const MEDIA_FRAME_CACHE_LIMIT = 24;
export const CLOSED_MEDIA_SESSION_LIMIT = 200;
export const MAX_MEDIA_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_MEDIA_DATA_URL_BYTES = 12 * 1024 * 1024;
export const X_GRAPHQL_ENDPOINT = "https://x.com/i/api/graphql";
export const X_BEARER_RE = /Bearer [A-Za-z0-9%._-]+/;
export const X_GRAPHQL_PAGE_FETCH_TIMEOUT_MS = 25000;
export const VIDEO_SAMPLING_DEFAULTS_VERSION = 3;
export const MIN_VIDEO_FRAME_INTERVAL_SECONDS = 0.2;
export const MIN_VIDEO_CHUNK_SECONDS = 10;
export const MAX_VIDEO_CHUNK_SECONDS = 60;
export const DEFAULT_VIDEO_CHUNK_SECONDS = 30;
export const MIN_VIDEO_CHUNK_CONCURRENCY = 1;
export const MAX_VIDEO_CHUNK_CONCURRENCY = 8;
export const DEFAULT_VIDEO_CHUNK_CONCURRENCY = 1;
/** Longest side for sampled video JPEG frames (capture encode). */
export const VIDEO_FRAME_MAX_SIDE = 720;
/** JPEG quality for sampled video frames. */
export const VIDEO_FRAME_JPEG_QUALITY = 0.72;
/** Parallel <video> seekers used during raw frame capture. */
export const VIDEO_CAPTURE_SEEK_WORKERS = 3;
/** Drop near-duplicate frames unless this many seconds have elapsed since the last kept frame. */
export const VIDEO_FRAME_MAX_GAP_SECONDS = 3.5;
/** Average-hash grid size for near-duplicate frame detection. */
export const VIDEO_FRAME_HASH_SIZE = 8;
/** Max Hamming distance to treat two frames as near-duplicates. */
export const VIDEO_FRAME_HASH_MAX_DISTANCE = 6;
/** Cache/strategy tag for multi-window video analysis (map windows, then text-only merge). */
export const VIDEO_ANALYSIS_STRATEGY = "change-timeline-v1";
/** Cache/strategy tag for video-attached audio analysis (map windows; AV merge is separate). */
export const AUDIO_ANALYSIS_STRATEGY = "chunked-audio-v1";
/** Combined audio+video text merge after both map phases finish. */
export const AV_ANALYSIS_MERGE_STRATEGY = "av-merge-v1";
/**
 * Shared system instructions for video frame analysis (sent as the
 * OpenAI-compatible system role). Keep chunk user prompts short.
 */
export const VIDEO_ANALYSIS_SYSTEM_PROMPT = [
  "You are a precise multimodal evidence extractor for AskLocal.",
  "You receive sparsely sampled video frames. Write compact, change-based notes — not a dump of every frame.",
  "Describe only what is visibly present. Never invent spoken dialogue, audio, or off-screen events.",
  "Prefer a short window/video summary plus a timeline of meaningful visual changes and key moments.",
  "Do not write one detailed bullet per sampled frame when consecutive frames show the same scene; note the range and what changes.",
  "Transcribe on-screen text that is not already covered by provided subtitle/caption cues. Prefer the provided cues for speech-like captions.",
  "Be uncertainty-aware. Do not write the final user-facing answer.",
  "Aim for roughly 400–700 characters of notes per ~30s window before any merge pass."
].join(" ");
/** Max decoded WAV payload across all audio chunks for one video analysis. */
export const MAX_AUDIO_CAPTURE_BYTES = 24 * 1024 * 1024;
/** Soft cap on audio chunk count (windows still follow videoChunkSeconds). */
export const MAX_AUDIO_CHUNKS = 24;
export const MIN_MULTI_LINKS = 1;
export const MAX_MULTI_LINKS = 8;
export const DEFAULT_MULTI_LINKS = 4;
export const PROVIDER_TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
export const PROVIDER_RETRY_LIMIT = 2;
export const PROVIDER_RETRY_BACKOFF_MS = 900;
/** How many times to re-prompt after llama.cpp rejects malformed tool-call markup. */
export const PROVIDER_FORMAT_RETRY_LIMIT = 2;
export const INVALID_MODEL_OUTPUT_HINT = [
  "Your previous reply was rejected because it did not match the required tool-call format.",
  "Do not write raw tool XML or JSON in the message body.",
  "Use the native tool-calling interface, or write a normal text answer. Try again."
].join(" ");
/** How often the ask Port posts keepalive traffic so Chrome does not suspend the MV3 worker. */
export const ASK_PORT_KEEPALIVE_MS = 5_000;
/** Per-window timeout for multimodal video analysis (local vision models can be slow). */
export const MEDIA_ANALYSIS_CHUNK_TIMEOUT_MS = 4 * 60 * 1000;
/** Progress pulse during a single slow vision/media call (must stay under Chrome's ~30s SW idle). */
export const MEDIA_ANALYSIS_CHUNK_HEARTBEAT_MS = 10_000;
/** Continuity notes passed into the next video window — keep small so later chunks do not snowball. */
export const MEDIA_ANALYSIS_CARRY_FORWARD_CHARS = 1200;
export const PROMPT_PRESETS = {
  explain: {
    label: "Explain",
    fallbackQuestion: "Explain this post.",
    task: [
      "- Explain what the selected post (and its media) is saying and why it matters in the thread.",
      "- Lead with the plain-language point, then add only the background needed to follow the argument.",
      "- Track who is responding to whom when replies matter.",
      "- Mention tone, assumptions, or missing context only when they change the meaning.",
      "- Use tools when text is truncated or a link, media, or current fact is needed to explain accurately.",
      "- Don't turn the explanation into a fact-check unless the claim needs verifying."
    ],
    output: [
      "- Use short sections such as ## Short answer, ## Context, and ## What to watch only when they help."
    ]
  },
  fact_check: {
    label: "Is this true?",
    fallbackQuestion: "Is this true?",
    task: [
      "- Identify the specific checkable claim(s) and who made them (thread root, selected post, or a reply). Separate checkable claims from opinion.",
      "- When search tools are offered, use them for current events, statistics, quotes, screenshots, identities, and dates, and open the key results with get before relying on them.",
      "- Without search tools, check the claim against the provided context and your general knowledge, say which one each point comes from, and call it unverified when neither settles it.",
      "- Prefer primary and authoritative sources, then reputable reporting. Engagement, screenshots, or a single post are not proof.",
      "- Separate fact from inference, opinion, and satire. Don't force a verdict when the evidence is thin."
    ],
    output: [
      "- Use ## Verdict, ## Evidence, and ## Caveats when the claim is checkable.",
      "- Make the verdict one sentence: true, mostly true, misleading, unverified, false, or opinion/not checkable, followed by the reason.",
      "- Name or link the sources the verdict rests on. Never cite a source you did not actually see in the context or tool results."
    ]
  },
  summarize: {
    label: "Summarize",
    fallbackQuestion: "Summarize this post.",
    task: [
      "- Summarize the substance of the selected post and, when relevant, the discussion around it.",
      "- When the post is mostly an image or video, the media is the post: summarize what the media analyses describe (events, people, on-screen text, speech). Mention engagement or timing only if asked.",
      "- Keep the main claim, key details, and important caveats; add nothing that isn't in the context.",
      "- Use tools only when truncated text or a missing link, media, or thread detail would make the summary misleading.",
      "- Keep jokes and speculation labeled as such."
    ],
    output: [
      "- Use ## Summary and ## Key details. Add ## Missing context only when something important is unavailable.",
      "- Keep it tight; a short answer beats a padded one."
    ]
  }
};
export const DONT_RETRY_HINT = "Do not retry the same id or arguments. Copy an exact id from didYouMean or the available listings, or answer from the context you already have.";
export const SEARCH_TAB_TIMEOUT_MS = 18000;
/** After clicking a bot-check, wait this long for SERP results before failing the engine. */
export const SEARCH_CHALLENGE_WAIT_MS = 5000;

