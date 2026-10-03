# AskLocal

AskLocal is a browser extension for X/Twitter that puts an **AskLocal** button on posts. Click it, ask a question, and an AI model answers using the post, its thread and replies, quoted posts, images, video, and linked articles as context. It can also search the web or X and open links to check claims ("Is this true?"). You bring the model: anything with an OpenAI-compatible API works, including local servers like Ollama and LM Studio, so your posts and questions don't have to leave your machine.

- **Explain / Summarize / Is this true?** presets, or ask anything about a post
- **Follow-up chat** that remembers the thread and what it already looked up
- **Reads media**: images and video (frames, captions, and audio) are analyzed and given to the model as text
- **Optional web and X search**, plus opening links and reading full threads
- **Local-first**: works with Ollama, LM Studio, llama.cpp, or hosted APIs like OpenAI and OpenRouter
- Chrome and Firefox

## About this project

This has been sitting on my hard drive for about five months. I kept meaning to clean it up, and I've decided to stop waiting and publish it. It works and I use it, but expect rough edges. It is not on the Chrome Web Store or Firefox Add-ons, so you install it by hand (below). Issues and pull requests are welcome.

## Install

Download the zip for your browser from the **Releases** page of this repository:

- `asklocal-chrome.zip` for Chrome, Chromium, Brave, Edge, and other Chromium browsers
- `asklocal-firefox.zip` for Firefox

AskLocal isn't published in the browser stores, so both browsers will warn you and need one setting changed to load it. What's needed is different in each.

### Chrome (and other Chromium browsers)

1. Unzip `asklocal-chrome.zip` into a folder you'll keep. Chrome loads the extension from that folder, so don't delete or move it afterward.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
5. Open x.com and a post. The AskLocal button appears on it.

Chrome may show a "Disable developer mode extensions" prompt on startup. Dismiss it; the extension keeps working. To update, unzip the new release over the same folder and click **Reload** on the extension's card.

### Firefox

Regular Firefox only permanently installs extensions signed by Mozilla, and AskLocal isn't. You have two options.

**Option A: temporary install (any Firefox, no settings to change).** The extension disappears when you close Firefox and has to be loaded again each time.

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `asklocal-firefox.zip` (you don't need to unzip it).

**Option B: permanent install (Developer Edition, Nightly, ESR, or an unbranded build).** Release Firefox ignores the setting below. Use one of these builds instead.

1. Open `about:config` and accept the warning.
2. Set `xpinstall.signatures.required` to `false`.
3. Open `about:addons`, click the gear icon, choose **Install Add-on From File...**, and select `asklocal-firefox.zip`. If Firefox doesn't accept the `.zip`, rename it to `asklocal-firefox.xpi` and try again.

Turning off signature checking lets any unsigned extension install, so only do it in a profile you're comfortable with, and turn it back on if you stop using AskLocal.

### Set up your model

The first time, open the extension's settings (toolbar icon, then options) and set:

- **Endpoint** and **Model**. The defaults are `http://localhost:11434/v1` and `llama3.2` (Ollama). The endpoint can be a base `/v1` URL or a full `/chat/completions` URL:
  - Ollama: `http://localhost:11434/v1`
  - LM Studio: `http://localhost:1234/v1`
  - OpenAI: `https://api.openai.com/v1`
  - OpenRouter: `https://openrouter.ai/api/v1`
- **API key**: optional for local servers, required for most hosted ones.
- **Model context length**: set this to the context size your server is actually running (default 32768). Ollama uses a much smaller window unless you raise it (`num_ctx` / `OLLAMA_CONTEXT_LENGTH`); LM Studio has a Context Length setting on the loaded model, and `llama-server` uses `-c`.

Click **Test connection** to check the endpoint and model. A model that supports tool calling gives the best results (web search, opening links, reading media on demand); models without it still answer from the post context.

### Performance

Settings → Performance has a profile that sets how much runs at once:

- **Local model** (default): one model call at a time, which suits a single GPU.
- **API provider**: for hosted APIs. It runs many vision and audio calls in parallel, captures several videos side by side, analyzes the windows of a long video concurrently, and analyzes more of a thread's media automatically.
- **Custom**: set the numbers yourself.

Whatever the profile, the X thread, linked articles and every image and video are read concurrently. Analysis of the clicked post's media starts from the page before the thread has loaded. Two optional toggles go further:

- **Start reading the post when the panel opens** begins the thread and media work while you pick a question.
- **Finish media analysis in the background** (on by default) lets analysis you stopped keep going into the cache.

### Privacy

AskLocal talks to X in your logged-in browser session and to the model endpoint you configure. Nothing goes to any AskLocal server, because there isn't one. If you point it at a hosted API, your questions and the post context go to that provider. Web search opens your configured search engine in a brief background tab. If the engine shows a proof-of-work "I'm not a robot" check (Brave does), AskLocal clicks it in that background tab and waits for it to finish; image or slider captchas that need a person are not attempted. Background profile scanning and web search are off by default.

## Build from source

Requires Node.js. From the repo root:

```sh
npm install
npm run build          # both browsers
npm run build:chrome   # -> build/chrome + build/asklocal-chrome.zip
npm run build:firefox  # -> build/firefox + build/asklocal-firefox.zip
npm run watch:chrome   # rebuild Chrome package on change
npm test               # parser, cache-identity and orchestration tests (node --test)
npm run check          # flags identifiers used but never defined
```

Load the **built** folder (or zip), not the raw `src/` tree, using the same steps as above. While developing, `npm run watch:chrome` plus **Reload** on the extension card is the quickest loop. For Firefox, `npx web-ext run --source-dir build/firefox --url https://x.com/home` starts a temporary profile with the extension loaded. The Firefox package uses a Manifest V2 wrapper for compatibility.

More detail: [docs/STREAMING.md](docs/STREAMING.md) (streaming architecture) and [docs/GROK_REPLACEMENT_ARCHITECTURE.md](docs/GROK_REPLACEMENT_ARCHITECTURE.md) (the Grok-panel integration).

## How it works in detail

### Providers and streaming

Answers stream into the panel as the model writes them (SSE); status updates about tool use and context gathering are shown either way. Streaming can be disabled in settings, and AskLocal falls back to non-streaming when a provider rejects `stream: true`. Stopping mid-stream keeps the partial answer. The settings page has a Test connection button that verifies the endpoint, lists available models (`/models`), and checks that the configured model exists.

### Context

AskLocal uses:

- The thread as a reply tree: the chain from the thread root down to the selected post, the selected post marked, and its replies indented under the post each one answers (with "replying to @handle" on every reply), instead of a flat list of top replies. Replies are a sample, and the map at the top says how many are shown. If X's reply links can't be loaded and only the page is available, placement follows page order and is flagged as approximate
- Media analyses printed directly under the post the image or video is on, so a post that is only a meme reads as that meme
- Current post, including its timestamp, engagement counts (replies/reposts/likes/views), repost attribution, external links, and link-preview cards
- A `textTruncated` flag on long posts cut off by "Show more", so the model knows to open the full post with `get`
- Visible thread posts only when asking from that post's status page
- Quoted post when visible (extracted from X's current quoted-post markup, which no longer nests an `article`)
- Video subtitles when X exposes caption text tracks or visible subtitle overlays
- Cached profile context from profiles you naturally visit

Ads (posts inside X's `placementTracking` wrapper or marked Promoted) are skipped. Every prompt includes the current date and time, and conversation history is sent to the provider as real chat message turns.

### Conversation history and context budget

The first question about a post sends the full post context (thread, replies, media analyses, auto-read links, author profiles) as plain text. That message is stored with the chat, and follow-ups replay it word for word as the first user turn, so the model still sees the thread on later turns and local servers can reuse their prompt cache. Follow-ups about the same post don't re-send or re-read that context. Tool results gathered while answering (opened pages, threads, media analyses, search results) are carried into the next message, and the short ids the model uses for tools (`p3`, `m1`, `l2`) keep pointing at the same items for the whole chat.

Everything sent (system prompt, tool schemas, history, post context, tool results) is budgeted against **Model context length** in settings. Set it to your server's real context length. When space runs out, AskLocal trims in this order: older follow-up detail, older turns, reply and article text, and finally old tool results, while keeping the original thread turn as long as it fits. If the provider still reports a context overflow, AskLocal shrinks and retries instead of failing. **Temperature** defaults to 0.3 to keep answers close to the sources. Models that only accept their default temperature, or that don't support tools, are detected and retried automatically.

While a request is running the Ask button becomes Stop and cancels the in-flight provider call. The panel tab bar has a New button that starts a fresh chat (clearing history and the media session), assistant replies have a Copy button, and Escape closes the panel.

Clicking X's floating Grok launcher opens native Grok and then attaches the AskLocal/Grok tab drawer. Switch back to AskLocal there for general questions without selected post context.

Background X profile scanning is disabled by default. It can be enabled in settings, where AskLocal may briefly open an inactive X tab to gather visible profile context and then close it.

Background search is disabled by default. It can be enabled in settings and limited to X search, browser web search, or both. When enabled for OpenAI-compatible providers, the model receives `x_search` and/or `web_search` tools based on that setting.

OpenAI-compatible providers also receive a `get` tool, which opens one or more X posts/threads or web links (by short id or URL) and returns their readable text and top replies to the model as compact text. The prompt already lists every post, media item, and link with its id, so no separate listing or lookup tool is offered.

When media analysis is enabled, OpenAI-compatible base providers also receive `analyze_image` and `analyze_video` tools. AskLocal also pre-processes media on the selected tweet when you click Ask: selected images and videos are both analyzed before the prompt is sent, producing a readable description in context regardless of whether the base model supports vision; images are additionally attached to the main multimodal request when "Use main provider for image analysis" is enabled and the base provider/model supports it. Finished analyses are saved on this device (IndexedDB) under the media file's own identity, not the post's, so the same image or video in a repost, a quote, or another chat is reused instead of analyzed again. Deleting a chat removes analyses only that chat used, and the settings page can clear the whole cache. Raw image bytes and video frames stay in memory for the panel's session only. Image and video analysis can use the main configured model/API or separate image/video provider settings. Videos are analyzed as timestamped in-memory image frame arrays sampled from the video's own natural playback (never by pausing or seeking it, so on-screen playback is never interrupted) plus detected subtitles/captions; the frame interval, maximum frame count (0 = no limit), and frames per minute (scales the count with video length, capped by the max frame count) are configurable in settings.
