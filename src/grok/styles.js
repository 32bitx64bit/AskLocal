// AskLocal — Grok-shell shadow DOM styles.
// Exposes a CSS string as AskLocalGrokStyles for the content script to inject
// into the panel's shadow root. Class names for the chat
// surface (.messages, .message, .message-body, .context-post, .suggestions,
// .chat-scroll, .composer, .primary, .status, source/thinking markers) are kept
// identical to the legacy panel so the shared rendering helpers apply unchanged.

export const AskLocalGrokStyles = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; }
  /* Author display rules otherwise beat the UA [hidden] stylesheet. */
  [hidden] { display: none !important; }

  .al-shell {
    background: transparent;
    color: light-dark(rgb(15,20,25), rgb(231,233,234));
    display: flex;
    flex-direction: column;
    font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    height: 100%;
    overflow: hidden;
    width: 100%;
  }
  .al-shell[data-mode="asklocal"] {
    background: light-dark(rgb(255,255,255), rgb(0,0,0));
  }

  .al-header {
    align-items: center;
    background: light-dark(rgb(255,255,255), rgb(0,0,0));
    border-bottom: 1px solid light-dark(rgb(239,243,244), rgb(47,51,54));
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
    min-height: 52px;
    padding: 8px 12px;
    pointer-events: auto;
  }
  .al-brand {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: -0.2px;
  }
  .al-tabs {
    display: flex;
    gap: 4px;
  }
  .al-tabs button {
    background: transparent;
    border: 0;
    border-radius: 0;
    color: rgb(113,118,123);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    font-weight: 700;
    padding: 10px 12px;
  }
  .al-tabs button.active {
    border-bottom: 4px solid rgb(29,155,240);
    color: inherit;
  }
  .al-actions {
    align-items: center;
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
  .al-icon,
  .al-close {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: rgb(113,118,123);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    height: 32px;
    justify-content: center;
    min-width: 32px;
    padding: 0 10px;
  }
  .al-close {
    font-size: 16px;
    padding: 0;
  }
  .al-icon:hover,
  .al-close:hover {
    background: light-dark(rgb(239,243,244), rgb(22,24,28));
    color: inherit;
  }

  .al-new {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: rgb(113,118,123);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    height: 36px;
    justify-content: center;
    padding: 0;
    width: 36px;
  }
  .al-new:hover {
    background: light-dark(rgb(239,243,244), rgb(22,24,28));
    color: inherit;
  }
  .al-new svg {
    display: block;
  }

  .al-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    pointer-events: auto;
  }
  .al-shell[data-mode="grok"] .al-body {
    display: none;
  }

  strong { display: block; font-size: 15px; line-height: 20px; }
  .status { color: rgb(113,118,123); font-size: 12px; line-height: 16px; }
  [data-model] { color: rgb(113,118,123); font-size: 12px; line-height: 16px; }
  button {
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
  }
  .suggestions button:hover { background: light-dark(rgb(239,243,244), rgb(22,24,28)); }

  .chat-scroll {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    padding: 12px 14px 104px;
    scroll-behavior: smooth;
  }
  .context-block {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 8px;
  }
  .context-block[hidden] {
    display: none;
  }
  .context-post {
    background: light-dark(rgb(247,249,249), rgb(16,20,24));
    border: 1px solid light-dark(rgb(239,243,244), rgb(47,51,54));
    border-radius: 8px;
    flex: 0 0 auto;
    padding: 12px;
  }
  .context-label {
    color: rgb(113,118,123);
    font-size: 12px;
    font-weight: 700;
    line-height: 16px;
    margin-bottom: 6px;
    text-transform: uppercase;
  }
  .context-author {
    align-items: baseline;
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  .context-author strong {
    display: inline;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .context-author span {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .context-post p {
    font-size: 14px;
    line-height: 20px;
    margin: 8px 0 0;
    max-height: 140px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .context-subtitles {
    color: rgb(113,118,123);
    font-size: 12px;
    line-height: 16px;
    margin-top: 8px;
  }
  .suggestions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 8px;
  }
  .suggestions button {
    background: light-dark(rgb(247,249,249), rgb(22,24,28));
    color: inherit;
    font-size: 13px;
    padding: 7px 10px;
    white-space: nowrap;
  }
  .messages {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;
  }
  .message {
    display: flex;
    width: 100%;
  }
  .message.user {
    align-items: flex-end;
    justify-content: flex-end;
  }
  .message.assistant {
    align-items: stretch;
    flex-direction: column;
    justify-content: flex-start;
  }
  .message-body {
    border-radius: 18px;
    box-sizing: border-box;
    font-size: 14px;
    line-height: 20px;
    max-width: 88%;
    padding: 10px 12px;
    word-break: break-word;
  }
  .message-body p,
  .message-body ul,
  .message-body ol,
  .message-body blockquote,
  .message-body pre {
    margin: 0 0 10px;
  }
  .message-body > :last-child {
    margin-bottom: 0;
  }
  .message-body ul,
  .message-body ol {
    padding-left: 20px;
  }
  .message-body li {
    margin: 4px 0;
    padding-left: 2px;
  }
  .message-body h3,
  .message-body h4,
  .message-body h5 {
    font-size: 14px;
    line-height: 20px;
    margin: 0 0 8px;
  }
  .message-body code {
    background: light-dark(rgba(15,20,25,0.08), rgba(255,255,255,0.12));
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    padding: 1px 4px;
  }
  .message-body pre {
    background: light-dark(rgb(247,249,249), rgb(16,20,24));
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    border-radius: 8px;
    overflow: auto;
    padding: 10px;
  }
  .message-body pre code {
    background: transparent;
    border-radius: 0;
    display: block;
    padding: 0;
    white-space: pre;
  }
  .message-body blockquote {
    border-left: 3px solid rgb(113,118,123);
    color: rgb(113,118,123);
    padding-left: 10px;
  }
  .message-body hr {
    border: none;
    border-top: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    margin: 10px 0;
  }
  .message-body del {
    opacity: 0.72;
  }
  .message-body .md-table {
    margin: 0 0 10px;
    max-width: 100%;
    overflow-x: auto;
  }
  .message-body .md-table table {
    border-collapse: collapse;
    font-size: 13px;
    line-height: 18px;
    width: 100%;
  }
  .message-body .md-table th,
  .message-body .md-table td {
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    padding: 5px 8px;
    text-align: left;
    vertical-align: top;
  }
  .message-body .md-table th {
    background: light-dark(rgb(247,249,249), rgb(22,26,31));
    font-weight: 600;
  }
  .message-body h6 {
    font-size: 13px;
    line-height: 18px;
    margin: 0 0 8px;
  }
  .message-body a {
    color: rgb(29,155,240);
    text-decoration: none;
  }
  .message-body a:hover {
    text-decoration: underline;
  }
  .message.user .message-body {
    background: rgb(29,155,240);
    color: white;
    white-space: pre-wrap;
  }
  .message.assistant .message-body {
    background: transparent;
    border-radius: 0;
    color: inherit;
    max-width: 100%;
    padding: 2px 2px 0;
  }
  .message.pending .message-body {
    color: rgb(83,100,113);
  }
  .thinking-row {
    align-items: center;
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  .thinking-dot {
    animation: asklocalPulse 1.1s ease-in-out infinite;
    background: rgb(29,155,240);
    border-radius: 999px;
    display: block;
    flex: 0 0 auto;
    height: 8px;
    width: 8px;
  }
  .thinking-label {
    color: inherit;
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @keyframes asklocalPulse {
    0%, 100% { opacity: 0.35; transform: scale(0.82); }
    50% { opacity: 1; transform: scale(1); }
  }
  .stopped-note {
    color: rgb(113,118,123);
    font-size: 12px;
    font-style: italic;
    line-height: 16px;
    margin: 6px 0 0 2px;
  }
  .message-actions {
    display: flex;
    gap: 6px;
    margin: 6px 0 0 2px;
  }
  .message-copy {
    background: transparent;
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    border-radius: 999px;
    color: rgb(113,118,123);
    font-size: 11px;
    font-weight: 700;
    padding: 3px 10px;
  }
  .message-copy:hover {
    background: light-dark(rgb(239,243,244), rgb(22,24,28));
    color: inherit;
  }
  .message-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0 0 2px;
    max-width: 100%;
  }
  .source-icon {
    align-items: center;
    background: light-dark(rgb(255,255,255), rgb(16,20,24));
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    border-radius: 999px;
    box-sizing: border-box;
    display: inline-flex;
    height: 24px;
    justify-content: center;
    overflow: hidden;
    text-decoration: none;
    width: 24px;
  }
  .source-icon:hover {
    border-color: rgb(29,155,240);
  }
  .source-icon img {
    display: block;
    height: 16px;
    width: 16px;
  }
  .source-fallback {
    color: rgb(83,100,113);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }
  .source-fallback[hidden],
  .source-icon img[hidden] {
    display: none !important;
  }
  .message.error .message-body {
    background: light-dark(rgb(255,235,238), rgb(56,24,30));
    color: light-dark(rgb(183,28,28), rgb(255,175,184));
  }

  .composer-wrap {
    background: light-dark(rgb(255,255,255), rgb(0,0,0));
    border-top: 1px solid light-dark(rgb(239,243,244), rgb(47,51,54));
    flex: 0 0 auto;
    padding: 8px 10px 10px;
  }
  .composer {
    align-items: flex-end;
    background: light-dark(rgb(255,255,255), rgb(16,20,24));
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    border-radius: 22px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.16);
    display: flex;
    gap: 8px;
    padding: 6px;
  }
  textarea {
    background: transparent;
    border: 0;
    box-sizing: border-box;
    color: inherit;
    display: block;
    flex: 1;
    font: inherit;
    font-size: 15px;
    height: 40px;
    line-height: 20px;
    max-height: 128px;
    min-height: 40px;
    outline: none;
    overflow: auto;
    padding: 10px 8px 8px 10px;
    resize: none;
    width: auto;
  }
  .primary {
    background: rgb(29,155,240);
    color: white;
    flex: 0 0 auto;
    font-weight: 700;
    min-height: 36px;
    padding: 0 16px;
  }
  .primary:disabled {
    cursor: default;
    opacity: 0.65;
  }
  .status {
    margin: 0 10px 6px;
    min-height: 0;
    overflow: hidden;
    pointer-events: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;
