/**
 * Streaming capture→analyze pipeline.
 *
 * Capture emits video windows / audio chunks as soon as each is ready; this module
 * runs LLM work under a concurrency limit so later capture overlaps earlier
 * transcription/vision instead of waiting for the full file first.
 */

import {
  DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  MAX_VIDEO_CHUNK_CONCURRENCY,
  MIN_VIDEO_CHUNK_CONCURRENCY
} from "../constants.js";
import {
  clampNumber,
  throwIfAborted
} from "../../lib/utils.js";
import {
  isFatalMediaProviderError
} from "../providers/errors.js";

/**
 * @param {object} options
 * @param {number} options.concurrency
 * @param {(item: object) => Promise<{ section?: string, error?: string }>} options.analyze
 * @param {{ start?: Function, finish?: Function, note?: Function, setTotal?: Function, bindHeartbeat?: Function }} [options.progress]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.ordered] - process by ascending index (carry-forward / concurrency 1)
 * @param {(prev: object|null, result: object, item: object) => object|null} [options.updateCarry] - ordered mode only
 */
export function createStreamingAnalysisPool({
  concurrency = DEFAULT_VIDEO_CHUNK_CONCURRENCY,
  analyze,
  progress = null,
  signal = null,
  ordered = false,
  updateCarry = null
}) {
  const limit = Math.floor(clampNumber(
    concurrency,
    MIN_VIDEO_CHUNK_CONCURRENCY,
    MAX_VIDEO_CHUNK_CONCURRENCY,
    DEFAULT_VIDEO_CHUNK_CONCURRENCY
  ));
  const byIndex = new Map();
  const results = new Map();
  const parallelQueue = [];
  const inFlight = new Set();
  let active = 0;
  let captureClosed = false;
  let fatalError = null;
  let previousCarry = null;
  let settle = null;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const checkDone = () => {
    if (fatalError) {
      settle?.reject(fatalError);
      settle = null;
      return;
    }
    if (!captureClosed || active > 0 || inFlight.size > 0) return;
    if (!ordered && parallelQueue.length) return;
    for (const index of byIndex.keys()) {
      if (!results.has(index)) return;
    }
    settle?.resolve({
      results,
      failedChunkCount: countFailures(results),
      chunkCount: results.size
    });
    settle = null;
  };

  const runItem = async (item) => {
    throwIfAborted(signal);
    if (fatalError) throw fatalError;
    inFlight.add(item.index);
    active += 1;
    progress?.start?.();
    try {
      const carry = ordered ? previousCarry : null;
      const outcome = await analyze({ ...item, previousCarry: carry });
      const section = String(outcome?.section || "").trim();
      const error = String(outcome?.error || "").trim();
      results.set(item.index, {
        index: item.index,
        ok: Boolean(section) && !error,
        section,
        error,
        rangeLabel: item.rangeLabel || "",
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds
      });
      if (ordered && typeof updateCarry === "function") {
        previousCarry = updateCarry(previousCarry, results.get(item.index), item);
      }
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) {
        fatalError = error;
        throw error;
      }
      if (isFatalMediaProviderError(error)) {
        fatalError = error;
        throw error;
      }
      const reason = String(error?.message || "Chunk analysis failed.").slice(0, 240);
      results.set(item.index, {
        index: item.index,
        ok: false,
        section: "",
        error: reason,
        rangeLabel: item.rangeLabel || "",
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds
      });
      progress?.note?.(
        `${item.kind || "media"} window ${item.index + 1} failed (${reason}). Continuing...`
      );
      if (ordered && typeof updateCarry === "function") {
        previousCarry = updateCarry(previousCarry, results.get(item.index), item);
      }
    } finally {
      inFlight.delete(item.index);
      active = Math.max(0, active - 1);
      progress?.finish?.();
      pump();
      checkDone();
    }
  };

  const pumpOrdered = () => {
    // Always advance the lowest enqueued index that has no result yet.
    // Skipped empty timeline windows never appear in byIndex, so gaps are fine.
    while (active < 1 && inFlight.size < 1 && !fatalError && !signal?.aborted) {
      let nextItem = null;
      let nextIndex = Infinity;
      for (const [index, item] of byIndex) {
        if (results.has(index) || inFlight.has(index)) continue;
        if (index < nextIndex) {
          nextIndex = index;
          nextItem = item;
        }
      }
      if (!nextItem) break;
      void runItem(nextItem);
      // runItem bumps active/inFlight synchronously before first await.
      if (active >= 1 || inFlight.size >= 1) break;
    }
  };

  const pumpParallel = () => {
    while (active < limit && parallelQueue.length && !fatalError && !signal?.aborted) {
      const item = parallelQueue.shift();
      if (!item || results.has(item.index) || inFlight.has(item.index)) continue;
      void runItem(item);
    }
  };

  const pump = () => {
    if (fatalError) {
      checkDone();
      return;
    }
    if (ordered) pumpOrdered();
    else pumpParallel();
    checkDone();
  };

  return {
    enqueue(item) {
      if (fatalError || signal?.aborted) return;
      const index = Math.max(0, Math.floor(Number(item?.index) || 0));
      if (byIndex.has(index) || results.has(index)) return;
      const estimatedTotal = Math.max(0, Math.floor(Number(item?.estimatedTotal) || 0));
      if (estimatedTotal) progress?.setTotal?.(estimatedTotal);
      const normalized = { ...item, index };
      byIndex.set(index, normalized);
      if (!ordered) parallelQueue.push(normalized);
      pump();
    },
    close() {
      captureClosed = true;
      pump();
      checkDone();
    },
    fail(error) {
      fatalError = error instanceof Error ? error : new Error(String(error || "Pipeline failed."));
      checkDone();
    },
    done,
    get size() {
      return byIndex.size;
    },
    get resultMap() {
      return results;
    }
  };
}

function countFailures(results) {
  let failed = 0;
  for (const value of results.values()) {
    if (!value?.ok) failed += 1;
  }
  return failed;
}

/**
 * Build ordered section strings from a streaming pool result map.
 */
export function sectionsFromPoolResults(results, {
  labelPrefix = "Window",
  failurePrefix = "Analysis failed for this window"
} = {}) {
  const ordered = [...results.values()].sort((left, right) => left.index - right.index);
  const total = ordered.length;
  return ordered.map((entry, position) => {
    const range = entry.rangeLabel ? ` (${entry.rangeLabel})` : "";
    const header = `=== ${labelPrefix} ${position + 1} of ${total}${range} ===`;
    if (entry.ok && entry.section) {
      const body = entry.section.replace(/^===[\s\S]*?===\n?/, "").trim();
      return `${header}\n${body}`;
    }
    const reason = entry.error || failurePrefix;
    return `${header}\n[${failurePrefix}: ${reason}]`;
  });
}
