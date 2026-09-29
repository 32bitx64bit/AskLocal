import { api } from "./api.js";
import {
  extractProviderError,
  fetchWithTimeout,
  parseProviderResponse
} from "./providers/errors.js";
import {
  resolveOpenAICompatibleEndpoint
} from "./providers/openai-compatible.js";

export async function testProvider(payload) {
  const endpoint = String(payload.endpoint || "").trim();
  const model = String(payload.model || "").trim();
  const apiKey = String(payload.apiKey || "");
  if (!endpoint) return { ok: false, error: "Endpoint is required." };

  try {
    return await testOpenAICompatibleProvider(endpoint, model, apiKey);
  } catch (error) {
    return { ok: false, error: error.message || "Connection test failed." };
  }
}
export async function testOpenAICompatibleProvider(endpoint, model, apiKey) {
  const chatUrl = resolveOpenAICompatibleEndpoint(endpoint);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // /models is cheap and doubles as a model list for the options page; fall back to a
  // tiny completion for servers that do not implement it.
  const modelsUrl = chatUrl.replace(/\/chat\/completions$/, "/models");
  try {
    const response = await fetchWithTimeout(modelsUrl, { headers }, 6000);
    if (response.ok) {
      const data = await response.json().catch(() => null);
      const models = (Array.isArray(data?.data) ? data.data : [])
        .map((entry) => String(entry?.id || ""))
        .filter(Boolean);
      if (models.length) {
        const modelFound = !model || models.includes(model);
        return {
          ok: true,
          provider: "openai-compatible",
          models,
          modelFound,
          detail: [
            `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available`,
            model ? (modelFound ? `"${model}" found.` : `"${model}" not in the list (may still work).`) : ""
          ].filter(Boolean).join("; ")
        };
      }
    }
  } catch {
    // Fall through to the completion probe.
  }

  if (!model) return { ok: false, error: "Enter a model name to run the completion test." };
  const response = await fetchWithTimeout(chatUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: "Reply with OK." }]
    })
  }, 20000);
  const data = await parseProviderResponse(response);
  if (!response.ok) {
    const detail = extractProviderError(data);
    return { ok: false, error: `Provider responded ${response.status}${detail ? ` - ${detail}` : ""}.` };
  }
  return {
    ok: true,
    provider: "openai-compatible",
    models: [],
    modelFound: true,
    detail: "Connected. Test completion succeeded."
  };
}

