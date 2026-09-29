import { api } from "../api.js";

// Schemas are serialized into every request, so descriptions stay short and each
// tool exposes one obvious way to call it. Executors still accept the older
// argument names (id, context_id, status_id, url, max_posts, …) for robustness.
// fetch and lookup are no longer offered: the prompt already lists every item with
// its id and @handle, and leaked ids are rewritten after generation.
export const GET_TOOL = {
  type: "function",
  function: {
    name: "get",
    description: "Open posts or web pages in full. X posts return the full text, quoted post, and top replies; web pages return readable text. Pass several ids or urls in one call.",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 8,
          description: "Short ids to open, copied exactly, e.g. [\"p3\", \"l2\"]."
        },
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 8,
          description: "Full http(s) or x.com URLs to open."
        }
      },
      additionalProperties: false
    }
  }
};
export const ANALYZE_IMAGE_TOOL = {
  type: "function",
  function: {
    name: "analyze_image",
    description: "Describe an image that has no analysis yet: visible details, text, screenshots, memes, charts.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Image id like m2, or the id of the post that contains it (p3)."
        },
        url: {
          type: "string",
          description: "Direct image URL, only when there is no id."
        },
        prompt: {
          type: "string",
          description: "Optional: what to look for."
        }
      },
      additionalProperties: false
    }
  }
};
export const ANALYZE_VIDEO_TOOL = {
  type: "function",
  function: {
    name: "analyze_video",
    description: "Describe a video that has no analysis yet (sampled frames plus captions/audio when available), including thread-root or ancestor videos a reply is about.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Video id like m1, or the id of the post that contains it (p3)."
        },
        url: {
          type: "string",
          description: "Direct video URL, only when there is no id."
        },
        prompt: {
          type: "string",
          description: "Optional: what to look for."
        }
      },
      additionalProperties: false
    }
  }
};
export const X_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "x_search",
    description: "Search X/Twitter posts. Returns post ids you can open with get.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Focused search query."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
};
export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web. Returns link ids with snippets; open the relevant ones with get before relying on them.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Focused search query."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
};
