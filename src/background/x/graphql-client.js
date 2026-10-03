import { api } from "../api.js";
import {
  withLane
} from "../orchestrator/tasks.js";
import {
  X_BEARER_RE,
  X_GRAPHQL_ENDPOINT,
  X_GRAPHQL_PAGE_FETCH_TIMEOUT_MS
} from "../constants.js";
import {
  decodeCookieValue
} from "../../lib/text.js";
import {
  isAllowedHttpUrl
} from "../../lib/url.js";
import {
  promiseWithAbortAndTimeout
} from "../../lib/utils.js";

export const X_CLIENT_SCRIPT_CACHE = new Map();
export const X_OPERATION_CACHE = new Map();
export async function requestXGraphQL(context, operationName, variables) {
  const session = await getXGraphQLSession(context);
  const operation = await resolveXGraphQLOperation(session, operationName);
  const url = `${X_GRAPHQL_ENDPOINT}/${operation.queryId}/${operationName}?${new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(operation.features),
    fieldToggles: JSON.stringify(operation.fieldToggles)
  }).toString()}`;
  const request = {
    url,
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: session.bearerToken,
      "X-CSRF-Token": decodeCookieValue(session.ct0),
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Client-Language": "en"
    }
  };

  return withLane("x", () => sendXGraphQL(context, operationName, variables, request), context.abortSignal);
}
async function sendXGraphQL(context, operationName, variables, request) {
  let result;
  try {
    result = await fetchXGraphQLFromBackground(request, context.abortSignal);
  } catch (error) {
    if (context.abortSignal?.aborted || error?.name === "AbortError") throw error;
    result = {
      ok: false,
      status: 0,
      statusText: "",
      text: "",
      data: null,
      error: error.message || "Background X GraphQL request failed.",
      source: "background_fetch"
    };
  }

  if (!result.ok && context.sourceTabId) {
    const pageResult = await fetchXGraphQLFromSourceTab(context, request);
    if (pageResult) result = pageResult;
  }

  if (!result.ok) {
    throw new Error(formatXGraphQLRequestError(operationName, result));
  }

  return result.data ?? {};
}
export async function fetchXGraphQLFromBackground(request, signal) {
  const response = await fetch(request.url, {
    credentials: "include",
    signal,
    headers: request.headers
  });
  const text = await response.text();
  return parseXGraphQLFetchResult({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
    source: "background_fetch"
  });
}
export async function fetchXGraphQLFromSourceTab(context, request) {
  try {
    const response = await promiseWithAbortAndTimeout(
      api.tabs.sendMessage(context.sourceTabId, {
        type: "ASKLOCAL_X_GRAPHQL_FETCH",
        payload: request
      }),
      context.abortSignal,
      X_GRAPHQL_PAGE_FETCH_TIMEOUT_MS
    );
    return parseXGraphQLFetchResult({
      ok: Boolean(response?.ok),
      status: Number(response?.status || 0),
      statusText: String(response?.statusText || ""),
      text: String(response?.text || ""),
      error: String(response?.error || ""),
      source: "source_tab_fetch"
    });
  } catch (error) {
    if (context.abortSignal?.aborted || error?.name === "AbortError") throw error;
    return parseXGraphQLFetchResult({
      ok: false,
      status: 0,
      statusText: "",
      text: "",
      error: error.message || "Could not fetch X GraphQL from the source tab.",
      source: "source_tab_fetch"
    });
  }
}
export function parseXGraphQLFetchResult(result) {
  const text = String(result.text || "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return {
    ok: Boolean(result.ok),
    status: Number(result.status || 0),
    statusText: String(result.statusText || ""),
    text,
    data,
    error: String(result.error || ""),
    source: String(result.source || "")
  };
}
export function formatXGraphQLRequestError(operationName, result = {}) {
  const detail = result.data?.errors?.[0]?.message
    || result.error
    || String(result.text || "").slice(0, 180);
  return `X ${operationName} request failed${result.source ? ` via ${result.source}` : ""}: ${result.status || 0}${detail ? ` - ${detail}` : ""}`;
}
export async function getXGraphQLSession(context) {
  const sourceTabId = context?.sourceTabId;
  if (!sourceTabId) throw new Error("No X tab was available for authenticated post context.");

  let response;
  try {
    response = await api.tabs.sendMessage(sourceTabId, { type: "ASKLOCAL_GET_X_SESSION" });
  } catch (error) {
    throw new Error(`Could not reach the X page for session context: ${error.message}`);
  }

  const session = response?.session ?? {};
  const scriptUrls = Array.isArray(session.scriptUrls) ? session.scriptUrls.filter(isAllowedHttpUrl) : [];
  if (!session.ct0) throw new Error("The X page did not expose a CSRF token for authenticated reads.");
  if (!scriptUrls.length) throw new Error("The X page did not expose client script URLs for GraphQL metadata.");

  const bearerToken = await resolveXBearerToken(scriptUrls);
  if (!bearerToken) throw new Error("Could not find X's bearer token in the loaded client bundle.");

  return {
    ct0: session.ct0,
    bearerToken,
    scriptUrls,
    pageUrl: session.url || ""
  };
}
export async function resolveXBearerToken(scriptUrls) {
  for (const url of scriptUrls) {
    const text = await fetchXClientScript(url);
    const token = text.match(X_BEARER_RE)?.[0] || "";
    if (token) return token;
  }
  return "";
}
export async function resolveXGraphQLOperation(session, operationName) {
  for (const url of session.scriptUrls) {
    const cacheKey = `${url}:${operationName}`;
    if (X_OPERATION_CACHE.has(cacheKey)) return X_OPERATION_CACHE.get(cacheKey);

    const text = await fetchXClientScript(url);
    const operation = extractXGraphQLOperation(text, operationName);
    if (operation) {
      X_OPERATION_CACHE.set(cacheKey, operation);
      return operation;
    }
  }
  throw new Error(`Could not find X GraphQL operation metadata for ${operationName}.`);
}
export async function fetchXClientScript(url) {
  if (X_CLIENT_SCRIPT_CACHE.has(url)) return X_CLIENT_SCRIPT_CACHE.get(url);
  const response = await fetch(url, {
    credentials: "omit",
    headers: { Accept: "application/javascript,text/javascript,*/*;q=0.5" }
  });
  if (!response.ok) throw new Error(`Could not load X client script: ${response.status}`);
  const text = await response.text();
  X_CLIENT_SCRIPT_CACHE.set(url, text);
  return text;
}
export function extractXGraphQLOperation(scriptText, operationName) {
  const marker = `operationName:"${operationName}"`;
  const markerIndex = scriptText.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = Math.max(0, scriptText.lastIndexOf("e.exports={", markerIndex));
  const chunk = scriptText.slice(start, markerIndex + 10000);
  const queryId = chunk.match(/queryId:"([^"]+)"/)?.[1] || "";
  if (!queryId) return null;

  return {
    queryId,
    operationName,
    features: extractXStringBooleanMap(chunk, "featureSwitches"),
    fieldToggles: extractXStringBooleanMap(chunk, "fieldToggles")
  };
}
export function extractXStringBooleanMap(chunk, propertyName) {
  const pattern = new RegExp(`${propertyName}:\\[([\\s\\S]*?)\\]`);
  const block = chunk.match(pattern)?.[1] || "";
  return Object.fromEntries([...block.matchAll(/"([^"]+)"/g)].map((match) => [match[1], true]));
}

