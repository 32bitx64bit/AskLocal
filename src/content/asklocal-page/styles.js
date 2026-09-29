export const AskLocalPageStyles = `
  :host {
    all: initial;
    color-scheme: light;
    font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  :host([data-asklocal-theme="dark"]) { color-scheme: dark; }
  * { box-sizing: border-box; }
  button, input, textarea { font: inherit; }
  /* Author display rules otherwise beat the UA [hidden] stylesheet. */
  [hidden] { display: none !important; }

  .al-page {
    background: light-dark(rgb(255,255,255), rgb(0,0,0));
    color: light-dark(rgb(15,20,25), rgb(231,233,234));
    display: flex;
    flex-direction: row;
    height: 100%;
    min-height: 0;
    position: relative;
    width: 100%;
  }

  /* Center chat volume; right rail mirrors the left sidebar width like /i/grok. */
  .al-page-volume {
    border-right: 1px solid light-dark(rgb(239,243,244), rgb(47,51,54));
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    position: relative;
  }
  .al-page-rail {
    flex: 0 0 var(--asklocal-mirror-rail, 0px);
    min-width: 0;
    pointer-events: none;
  }

  .al-page-header {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
    justify-content: flex-end;
    min-height: 53px;
    padding: 8px 16px;
    position: sticky;
    top: 0;
    z-index: 2;
    background: light-dark(rgba(255,255,255,0.85), rgba(0,0,0,0.85));
    backdrop-filter: blur(12px);
  }
  .al-page-header .al-brand {
    font-size: 20px;
    font-weight: 800;
    margin-right: auto;
    letter-spacing: -0.3px;
  }
  .al-page-header button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
    height: 36px;
    padding: 0 14px;
  }
  .al-page-header button:hover {
    background: light-dark(rgb(239,243,244), rgb(22,24,28));
  }
  .al-page-header button.active {
    background: light-dark(rgb(239,243,244), rgb(32,35,39));
  }

  .al-page-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }

  .al-view { display: none; flex: 1; flex-direction: column; min-height: 0; }
  .al-view.active { display: flex; }

  .al-view-chat.is-empty .al-chat-scroll { display: none !important; }
  .al-view-chat:not(.is-empty) .al-welcome { display: none !important; }

  .al-welcome {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 18px;
    padding: 24px 16px 120px;
    text-align: center;
  }
  .al-welcome h1 {
    font-size: 34px;
    font-weight: 800;
    letter-spacing: -0.6px;
    margin: 0;
  }
  .al-welcome p {
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
    font-size: 15px;
    margin: 0;
    max-width: 420px;
  }

  .al-chat-scroll {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    overflow: auto;
    padding: 16px 16px 140px;
  }
  .al-chat-scroll .messages {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin: 0 auto;
    max-width: min(820px, 100%);
    width: 100%;
  }
  .message {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .message.user {
    align-items: flex-end;
  }
  .message.user .message-body {
    background: light-dark(rgb(239,243,244), rgb(32,35,39));
    border-radius: 18px;
    max-width: min(560px, 92%);
    padding: 10px 14px;
    white-space: pre-wrap;
  }
  .message.assistant .message-body {
    font-size: 15px;
    line-height: 1.5;
    max-width: min(820px, 100%);
  }
  .message.assistant.pending .message-body {
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
  }
  .message.assistant.error .message-body {
    color: rgb(244,33,46);
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
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
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
    color: light-dark(rgb(113,118,123), rgb(113,118,123));
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
    cursor: pointer;
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
    flex: 0 0 auto;
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
    object-fit: contain;
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

  .al-composer-dock {
    background: linear-gradient(to top, light-dark(rgb(255,255,255), rgb(0,0,0)) 70%, transparent);
    bottom: 0;
    left: 0;
    padding: 12px 16px 20px;
    position: absolute;
    right: 0;
  }
  .al-composer-card {
    background: light-dark(rgb(239,243,244), rgb(22,24,28));
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    border-radius: 28px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 auto;
    max-width: min(820px, 100%);
    padding: 12px 14px;
    width: 100%;
  }
  .al-composer-card textarea {
    background: transparent;
    border: 0;
    color: inherit;
    max-height: 180px;
    min-height: 28px;
    outline: none;
    resize: none;
    width: 100%;
  }
  .al-composer-toolbar {
    align-items: center;
    display: flex;
    gap: 8px;
  }
  .al-composer-toolbar .status {
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
    flex: 1;
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .al-composer-toolbar select[data-model-select] {
    background: light-dark(rgb(255,255,255), rgb(0,0,0));
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    border-radius: 999px;
    color: inherit;
    cursor: pointer;
    flex: 0 1 auto;
    font-size: 13px;
    font-weight: 600;
    height: 34px;
    max-width: 180px;
    min-width: 96px;
    padding: 0 10px;
  }
  .al-composer-toolbar button {
    background: light-dark(rgb(15,20,25), rgb(239,243,244));
    border: 0;
    border-radius: 999px;
    color: light-dark(rgb(255,255,255), rgb(15,20,25));
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
    height: 34px;
    padding: 0 16px;
  }
  .al-composer-toolbar button.secondary {
    background: transparent;
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    color: inherit;
  }
  .al-composer-toolbar button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .al-settings-frame {
    border: 0;
    flex: 1;
    min-height: 0;
    width: 100%;
  }

  .al-history-backdrop {
    background: rgba(0,0,0,0.4);
    inset: 0;
    position: absolute;
    z-index: 5;
  }
  .al-history-drawer {
    background: light-dark(rgb(255,255,255), rgb(0,0,0));
    border-left: 1px solid light-dark(rgb(239,243,244), rgb(47,51,54));
    bottom: 0;
    display: flex;
    flex-direction: column;
    max-width: 100%;
    position: absolute;
    right: 0;
    top: 0;
    width: 400px;
    z-index: 6;
  }
  .al-history-drawer header {
    align-items: center;
    display: flex;
    gap: 8px;
    min-height: 53px;
    padding: 8px 12px;
  }
  .al-history-drawer header h2 {
    flex: 1;
    font-size: 20px;
    font-weight: 800;
    margin: 0;
  }
  .al-history-drawer header button {
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: inherit;
    cursor: pointer;
    height: 34px;
    padding: 0 10px;
  }
  .al-history-search {
    padding: 0 12px 12px;
  }
  .al-history-search input {
    background: light-dark(rgb(239,243,244), rgb(22,24,28));
    border: 1px solid light-dark(rgb(207,217,222), rgb(47,51,54));
    border-radius: 999px;
    color: inherit;
    height: 42px;
    outline: none;
    padding: 0 16px;
    width: 100%;
  }
  .al-history-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 8px 16px;
  }
  .al-history-empty {
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
    font-size: 14px;
    padding: 24px 12px;
    text-align: center;
  }
  .al-history-item {
    align-items: flex-start;
    border-radius: 14px;
    cursor: pointer;
    display: flex;
    gap: 8px;
    padding: 10px 10px;
  }
  .al-history-item:hover,
  .al-history-item.active {
    background: light-dark(rgb(239,243,244), rgb(22,24,28));
  }
  .al-history-item .meta {
    flex: 1;
    min-width: 0;
  }
  .al-history-item .title {
    font-size: 15px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .al-history-item .preview {
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
    font-size: 13px;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .al-history-item .when {
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
    font-size: 12px;
    margin-top: 4px;
  }
  .al-history-item .delete {
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: light-dark(rgb(83,100,113), rgb(113,118,123));
    cursor: pointer;
    flex: 0 0 auto;
    font-size: 12px;
    font-weight: 700;
    height: 28px;
    padding: 0 8px;
  }
  .al-history-item .delete:hover {
    background: rgba(244,33,46,0.12);
    color: rgb(244,33,46);
  }

  a { color: rgb(29,155,240); }
`;
