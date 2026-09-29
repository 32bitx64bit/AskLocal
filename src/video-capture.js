const MAX_CAPTURE_VIDEO_BYTES = 120 * 1024 * 1024;
const MIN_VIDEO_FRAME_INTERVAL_SECONDS = 0.2;
const MIN_AUDIO_CHUNK_SECONDS = 10;
const MAX_AUDIO_CHUNK_SECONDS = 60;
const DEFAULT_AUDIO_CHUNK_SECONDS = 30;
const MAX_AUDIO_CAPTURE_BYTES = 24 * 1024 * 1024;
const MAX_AUDIO_CHUNKS = 24;
const AUDIO_TARGET_SAMPLE_RATE = 16000;
/** Keep in sync with background/constants.js VIDEO_FRAME_*. */
const VIDEO_FRAME_MAX_SIDE = 720;
const VIDEO_FRAME_JPEG_QUALITY = 0.72;
/** Parallel <video> seekers for raw frame capture. */
const VIDEO_CAPTURE_SEEK_WORKERS = 3;
const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ASKLOCAL_CAPTURE_RAW_VIDEO_FRAMES") return false;
  captureRawVideoFrames(message.payload ?? {})
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      frames: [],
      audioChunks: [],
      error: error?.message || "Video capture failed."
    }));
  return true;
});

async function captureRawVideoFrames(payload) {
  const videoUrl = String(payload.videoUrl || "").trim();
  if (!videoUrl) return { ok: false, frames: [], audioChunks: [], error: "Video URL was empty." };
  const captureId = String(payload.captureId || "");
  const includeAudio = Boolean(payload.includeAudio);
  const audioUrl = String(payload.audioUrl || "").trim();
  const chunkSeconds = clampNumber(payload.chunkSeconds, MIN_AUDIO_CHUNK_SECONDS, MAX_AUDIO_CHUNK_SECONDS, DEFAULT_AUDIO_CHUNK_SECONDS);
  const streamWindows = payload.streamWindows !== false;

  const maxFrames = Math.floor(clampNumber(payload.maxFrames, 0, Infinity, 36));
  const frameIntervalSeconds = clampNumber(payload.frameIntervalSeconds, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, 1);
  const framesPerMinute = Math.floor(clampNumber(payload.framesPerMinute, 0, Infinity, 12));
  const options = { maxFrames, frameIntervalSeconds, framesPerMinute, chunkSeconds, streamWindows };

  try {
    if (includeAudio) {
      return await captureFramesAndAudioFromUrl(videoUrl, options, {
        captureId,
        chunkSeconds,
        audioUrl
      });
    }

    const direct = await captureWithVideoSource(videoUrl, options, captureId, "raw video");
    if (direct.ok || !isCanvasAccessError(direct.error)) {
      return { ...direct, audioChunks: [] };
    }

    await reportCaptureProgress(captureId, "Retrying video capture from a downloaded raw file...");
    const blob = await fetchMediaBlob(videoUrl, captureId, "raw video");
    const objectUrl = URL.createObjectURL(blob);
    try {
      const result = await captureWithVideoSource(objectUrl, options, captureId, "downloaded raw video");
      return { ...result, audioChunks: [] };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (error) {
    return {
      ok: false,
      frames: [],
      audioChunks: [],
      error: describeNetworkFailure(error, videoUrl)
    };
  }
}

async function captureFramesAndAudioFromUrl(videoUrl, options, meta) {
  const { captureId, chunkSeconds, audioUrl } = meta;
  const streamChunks = options.streamWindows !== false;

  // Prefer separate audio track + direct video seeking so we do not download a
  // giant muxed MP4 just to sample frames.
  if (audioUrl) {
    await reportCaptureProgress(captureId, "Capturing frames and separate audio track in parallel...");
    let audioError = "";
    const framePromise = (async () => {
      const direct = await captureWithVideoSource(videoUrl, options, captureId, "raw video");
      if (direct.ok || !isCanvasAccessError(direct.error)) return direct;
      await reportCaptureProgress(captureId, "Retrying frame capture from a downloaded raw file...");
      const blob = await fetchMediaBlob(videoUrl, captureId, "raw video");
      const objectUrl = URL.createObjectURL(blob);
      try {
        return await captureWithVideoSource(objectUrl, options, captureId, "downloaded raw video");
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    })();
    const audioPromise = (async () => {
      const audioBlob = await fetchMediaBlob(audioUrl, captureId, "raw audio track");
      const audioBuffer = await audioBlob.arrayBuffer();
      return extractAudioChunksFromArrayBuffer(
        audioBuffer,
        chunkSeconds,
        captureId,
        "separate audio track",
        { streamChunks }
      );
    })().catch((error) => {
      audioError = error?.message || "Could not decode separate audio track.";
      return [];
    });

    const [frameResult, audioChunks] = await Promise.all([framePromise, audioPromise]);
    if (frameResult.ok || audioChunks.length) {
      return {
        ok: Boolean(frameResult.ok || audioChunks.length),
        frames: frameResult.frames || [],
        audioChunks,
        duration: frameResult.duration,
        width: frameResult.width,
        height: frameResult.height,
        error: frameResult.ok ? "" : (frameResult.error || ""),
        audioError: audioChunks.length ? "" : audioError
      };
    }
    await reportCaptureProgress(captureId, "Separate audio path failed; falling back to muxed video download...");
  }

  await reportCaptureProgress(captureId, "Downloading raw video for frames and audio...");
  const blob = await fetchMediaBlob(videoUrl, captureId, "raw video");
  const arrayBuffer = await blob.arrayBuffer();
  const objectUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: blob.type || "video/mp4" }));

  let frameResult;
  let audioChunks = [];
  let audioError = "";
  try {
    const framePromise = captureWithVideoSource(objectUrl, options, captureId, "downloaded raw video");
    const audioPromise = extractAudioChunksFromArrayBuffer(
      arrayBuffer.slice(0),
      chunkSeconds,
      captureId,
      "muxed video audio",
      { streamChunks }
    ).catch((error) => {
      audioError = error?.message || "Could not decode muxed video audio.";
      return [];
    });

    frameResult = await framePromise;
    audioChunks = await audioPromise;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  if (!audioChunks.length && audioUrl) {
    try {
      await reportCaptureProgress(captureId, "Muxed audio was empty; trying separate X audio track...");
      const audioBlob = await fetchMediaBlob(audioUrl, captureId, "raw audio track");
      const audioBuffer = await audioBlob.arrayBuffer();
      audioChunks = await extractAudioChunksFromArrayBuffer(
        audioBuffer,
        chunkSeconds,
        captureId,
        "separate audio track",
        { streamChunks }
      );
      audioError = "";
    } catch (error) {
      if (!audioChunks.length) {
        audioError = error?.message || audioError || "Could not decode separate audio track.";
      }
    }
  }

  if (!frameResult.ok && !audioChunks.length) {
    return {
      ok: false,
      frames: [],
      audioChunks: [],
      error: frameResult.error || audioError || "Video and audio capture failed."
    };
  }

  return {
    ok: Boolean(frameResult.ok || audioChunks.length),
    frames: frameResult.frames || [],
    audioChunks,
    duration: frameResult.duration,
    width: frameResult.width,
    height: frameResult.height,
    error: frameResult.ok ? "" : (frameResult.error || ""),
    audioError: audioChunks.length ? "" : audioError
  };
}

async function extractAudioChunksFromArrayBuffer(arrayBuffer, chunkSeconds, captureId, label, streamOptions = {}) {
  await reportCaptureProgress(captureId, `Decoding ${label}...`);
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) throw new Error("Web Audio API is unavailable in this capture context.");

  const streamChunks = streamOptions.streamChunks !== false;
  const audioContext = new AudioCtx();
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    const duration = Number(decoded.duration) || 0;
    if (!duration || !decoded.numberOfChannels) {
      throw new Error("Decoded media had no usable audio track.");
    }

    const mono = mixToMono(decoded);
    const resampled = resampleLinear(mono, decoded.sampleRate, AUDIO_TARGET_SAMPLE_RATE);
    const windowSeconds = clampNumber(chunkSeconds, MIN_AUDIO_CHUNK_SECONDS, MAX_AUDIO_CHUNK_SECONDS, DEFAULT_AUDIO_CHUNK_SECONDS);
    const windows = buildAudioWindows(duration, windowSeconds);
    await reportCaptureProgress(captureId, `Slicing ${windows.length} audio chunk${windows.length === 1 ? "" : "s"} from ${label}...`, {
      event: "capture_meta",
      totalAudioChunks: windows.length,
      durationSeconds: duration
    });

    const chunks = [];
    let totalBytes = 0;
    for (const [index, window] of windows.entries()) {
      const pcm = slicePcm(resampled, AUDIO_TARGET_SAMPLE_RATE, window.startSeconds, window.endSeconds);
      if (!pcm.length) continue;
      const wavBytes = encodeWavPcm16(pcm, AUDIO_TARGET_SAMPLE_RATE);
      const dataUrl = `data:audio/wav;base64,${bytesToBase64(wavBytes)}`;
      if (totalBytes + dataUrl.length > MAX_AUDIO_CAPTURE_BYTES) {
        await reportCaptureProgress(captureId, `Stopped audio capture after ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} (size limit).`);
        break;
      }
      totalBytes += dataUrl.length;
      const chunk = {
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        durationSeconds: Math.max(0, window.endSeconds - window.startSeconds),
        dataUrl,
        mimeType: "audio/wav",
        sampleRate: AUDIO_TARGET_SAMPLE_RATE,
        label: `audio ${formatTimestamp(window.startSeconds)}-${formatTimestamp(window.endSeconds)}`,
        rangeLabel: `${formatTimestamp(window.startSeconds)}-${formatTimestamp(window.endSeconds)}`
      };
      chunks.push(chunk);
      if (streamChunks) {
        // Deliver each chunk immediately so transcription can start while more are sliced.
        // Non-blocking: do not stall slicing on extension IPC.
        void reportCaptureProgress(
          captureId,
          `Captured audio chunk ${chunks.length} of ${Math.min(windows.length, MAX_AUDIO_CHUNKS)}...`,
          {
            event: "audio_chunk",
            audioChunk: {
              ...chunk,
              index: chunks.length - 1,
              estimatedTotal: Math.min(windows.length, MAX_AUDIO_CHUNKS)
            }
          }
        );
      } else if (index === windows.length - 1 || index % 2 === 0) {
        void reportCaptureProgress(captureId, `Captured audio chunk ${chunks.length} of ${Math.min(windows.length, MAX_AUDIO_CHUNKS)}...`, {
          currentAudioChunk: chunks.length,
          totalAudioChunks: Math.min(windows.length, MAX_AUDIO_CHUNKS)
        });
      }
      if (chunks.length >= MAX_AUDIO_CHUNKS) break;
    }

    if (!chunks.length) throw new Error("No audio chunks were produced from the decoded media.");
    await reportCaptureProgress(captureId, `Captured ${chunks.length} audio chunk${chunks.length === 1 ? "" : "s"} from ${label}.`, {
      capturedAudioChunks: chunks.length
    });
    return chunks;
  } finally {
    try { await audioContext.close(); } catch { /* ignore */ }
  }
}

function buildAudioWindows(duration, chunkSeconds) {
  const windows = [];
  const endBound = Math.max(0, duration);
  for (let start = 0; start < endBound; start += chunkSeconds) {
    const end = Math.min(endBound, start + chunkSeconds);
    if (end - start < 0.2) break;
    windows.push({
      startSeconds: Number(start.toFixed(3)),
      endSeconds: Number(end.toFixed(3))
    });
    if (windows.length >= MAX_AUDIO_CHUNKS) break;
  }
  if (!windows.length && endBound > 0) {
    windows.push({ startSeconds: 0, endSeconds: Number(endBound.toFixed(3)) });
  }
  return windows;
}

function mixToMono(audioBuffer) {
  const length = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      mono[index] += data[index] / channels;
    }
  }
  return mono;
}

function resampleLinear(input, fromRate, toRate) {
  if (!input.length) return input;
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = sourceIndex - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function slicePcm(samples, sampleRate, startSeconds, endSeconds) {
  const start = Math.max(0, Math.floor(startSeconds * sampleRate));
  const end = Math.min(samples.length, Math.ceil(endSeconds * sampleRate));
  if (end <= start) return new Float32Array(0);
  return samples.subarray(start, end);
}

function encodeWavPcm16(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function describeNetworkFailure(error, videoUrl) {
  const message = String(error?.message || error || "").trim();
  const lower = message.toLowerCase();
  if (
    lower.includes("networkerror when attempting to fetch")
    || lower === "failed to fetch"
    || lower.includes("network request failed")
    || lower.includes("load failed")
  ) {
    let host = "the video host";
    try { host = new URL(videoUrl).host || host; } catch { /* keep default */ }
    return `Could not reach ${host} to load the raw video. Firefox may be blocking the request, or the URL expired.`;
  }
  return message || "Video capture failed.";
}

async function captureWithVideoSource(src, options, captureId, label) {
  const probe = createCaptureVideoElement();
  document.body.append(probe);

  try {
    await reportCaptureProgress(captureId, `Loading ${label} metadata...`);
    probe.src = src;
    probe.load();
    await waitForVideoReady(probe, 20000);

    if (!probe.videoWidth || !probe.videoHeight) {
      return { ok: false, frames: [], error: "Video loaded without dimensions." };
    }

    const duration = Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 0;
    if (!duration) return { ok: false, frames: [], error: "Video loaded without a finite duration." };

    try { probe.pause(); } catch {}
    const chunkSeconds = clampNumber(
      options.chunkSeconds,
      MIN_AUDIO_CHUNK_SECONDS,
      MAX_AUDIO_CHUNK_SECONDS,
      DEFAULT_AUDIO_CHUNK_SECONDS
    );
    const streamWindows = options.streamWindows !== false && chunkSeconds > 0;
    const estimatedWindows = Math.max(1, Math.ceil(duration / chunkSeconds));
    await reportCaptureProgress(captureId, `Loaded video (${formatDuration(duration)}, ${probe.videoWidth}x${probe.videoHeight}).`, {
      event: "capture_meta",
      durationSeconds: duration,
      width: probe.videoWidth,
      height: probe.videoHeight,
      estimatedVideoWindows: estimatedWindows,
      chunkSeconds
    });

    const times = buildCaptureTimes(duration, options.maxFrames, options.frameIntervalSeconds, options.framesPerMinute);
    const workerCount = Math.max(1, Math.min(VIDEO_CAPTURE_SEEK_WORKERS, times.length));
    await reportCaptureProgress(captureId, `Sampling ${times.length} video frame${times.length === 1 ? "" : "s"} (${workerCount} seek worker${workerCount === 1 ? "" : "s"})...`, {
      totalFrames: times.length,
      durationSeconds: duration,
      seekWorkers: workerCount
    });

    const frameSlots = new Array(times.length).fill(null);
    const failedSlots = new Array(times.length).fill(false);
    let lastFrameError = "";
    let lastProgressAt = 0;
    let nextFlushWindow = 0;
    let completedCount = 0;

    const flushCompleteWindows = (forceFinal = false) => {
      if (!streamWindows) return;
      while (nextFlushWindow < estimatedWindows) {
        let windowStart = -1;
        let windowEnd = -1;
        for (let index = 0; index < times.length; index += 1) {
          const windowIndex = Math.floor(Math.max(0, times[index]) / chunkSeconds);
          if (windowIndex < nextFlushWindow) continue;
          if (windowIndex > nextFlushWindow) break;
          if (windowStart < 0) windowStart = index;
          windowEnd = index;
        }

        if (windowStart < 0) {
          // No sampled frames land in this window — skip it.
          nextFlushWindow += 1;
          continue;
        }

        for (let index = windowStart; index <= windowEnd; index += 1) {
          if (!frameSlots[index] && !failedSlots[index]) {
            if (forceFinal) continue;
            return;
          }
        }

        const payloadFrames = [];
        for (let index = windowStart; index <= windowEnd; index += 1) {
          if (frameSlots[index]) payloadFrames.push(frameSlots[index]);
        }
        const startSeconds = nextFlushWindow * chunkSeconds;
        const endSeconds = Math.min(duration, (nextFlushWindow + 1) * chunkSeconds);
        if (payloadFrames.length) {
          // Non-blocking: seek workers must not wait on extension IPC with large payloads.
          void reportCaptureProgress(
            captureId,
            `Video window ready ${nextFlushWindow + 1}/${estimatedWindows} (${formatTimestamp(startSeconds)}-${formatTimestamp(endSeconds)})...`,
            {
              event: "video_window",
              videoWindow: {
                index: nextFlushWindow,
                startSeconds,
                endSeconds,
                rangeLabel: `${formatTimestamp(startSeconds)}-${formatTimestamp(endSeconds)}`,
                frames: payloadFrames,
                estimatedTotal: estimatedWindows,
                final: forceFinal && nextFlushWindow >= estimatedWindows - 1
              }
            }
          );
        }
        nextFlushWindow += 1;
      }
    };

    const onFrameProgress = (time) => {
      completedCount += 1;
      const now = performance.now();
      if (now - lastProgressAt > 500 || completedCount >= times.length) {
        lastProgressAt = now;
        reportCaptureProgress(captureId, `Capturing video frame ${completedCount} of ${times.length} (${formatTimestamp(time)})...`, {
          currentFrame: completedCount,
          totalFrames: times.length,
          timestampSeconds: time,
          timestamp: formatTimestamp(time)
        });
      }
    };

    const partitions = partitionTimesContiguous(times, workerCount);
    const workerVideos = [probe];
    try {
      for (let workerIndex = 1; workerIndex < partitions.length; workerIndex += 1) {
        const video = createCaptureVideoElement();
        document.body.append(video);
        video.src = src;
        video.load();
        await waitForVideoReady(video, 20000);
        try { video.pause(); } catch {}
        workerVideos.push(video);
      }

      await Promise.all(partitions.map(async (partition, workerIndex) => {
        const video = workerVideos[workerIndex];
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        for (const { index, time } of partition) {
          try {
            const frame = await seekAndDrawFrame(video, time, canvas, ctx);
            if (frame) {
              frameSlots[index] = frame;
            } else {
              failedSlots[index] = true;
            }
          } catch (error) {
            failedSlots[index] = true;
            lastFrameError = error?.message || "Could not capture one video frame.";
          }
          onFrameProgress(time);
          flushCompleteWindows(false);
        }
      }));
    } finally {
      for (const video of workerVideos) {
        if (video !== probe) destroyCaptureVideoElement(video);
      }
    }

    flushCompleteWindows(true);

    const frames = frameSlots.filter(Boolean);
    if (frames.length) {
      await reportCaptureProgress(captureId, `Captured ${frames.length} video frame${frames.length === 1 ? "" : "s"}.`, {
        capturedFrames: frames.length,
        totalFrames: times.length
      });
    } else {
      await reportCaptureProgress(captureId, "Raw video loaded, but no readable frames were captured.");
    }

    return frames.length
      ? { ok: true, frames, duration, width: probe.videoWidth, height: probe.videoHeight }
      : { ok: false, frames: [], error: lastFrameError || "No frames were captured from the raw video." };
  } catch (error) {
    return { ok: false, frames: [], error: error?.message || "Video capture failed." };
  } finally {
    destroyCaptureVideoElement(probe);
  }
}

function createCaptureVideoElement() {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;";
  return video;
}

function destroyCaptureVideoElement(video) {
  if (!video) return;
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  try { video.load(); } catch {}
  video.remove();
}

/** Split timestamps into contiguous spans so early windows can flush while later seeks continue. */
function partitionTimesContiguous(times, workerCount) {
  const count = Math.max(1, Math.min(Math.floor(workerCount) || 1, times.length || 1));
  if (count <= 1) {
    return [times.map((time, index) => ({ index, time }))];
  }
  const partitions = Array.from({ length: count }, () => []);
  const span = Math.ceil(times.length / count);
  for (let workerIndex = 0; workerIndex < count; workerIndex += 1) {
    const start = workerIndex * span;
    const end = Math.min(times.length, start + span);
    for (let index = start; index < end; index += 1) {
      partitions[workerIndex].push({ index, time: times[index] });
    }
  }
  return partitions.filter((partition) => partition.length);
}

function buildCaptureTimes(duration, maxFrames, frameIntervalSeconds, framesPerMinute) {
  const frameLimit = Math.max(0, Math.floor(Number(maxFrames) || 0));
  const fpmCount = framesPerMinute > 0 ? Math.max(1, Math.round((framesPerMinute * duration) / 60)) : 0;
  if (fpmCount > 0) {
    const count = frameLimit > 0 ? Math.min(frameLimit, fpmCount) : fpmCount;
    return buildDistributedCaptureTimes(duration, count);
  }

  const interval = clampNumber(frameIntervalSeconds, MIN_VIDEO_FRAME_INTERVAL_SECONDS, 30, 1);
  const endTime = Math.max(0, duration - 0.05);
  const times = [];
  for (let time = 0; time <= endTime + 0.001; time += interval) {
    times.push(Number(Math.min(endTime, time).toFixed(3)));
    if (times.length >= 5000) break;
  }
  if (!times.length) times.push(0);
  if (times.at(-1) < endTime - 0.001) times.push(Number(endTime.toFixed(3)));
  return limitCaptureTimes(uniqueBy(times, (time) => time.toFixed(3)), frameLimit);
}

function buildDistributedCaptureTimes(duration, count) {
  if (count <= 1) return [0];
  const endTime = Math.max(0, duration - 0.05);
  const times = [];
  const step = endTime / (count - 1);
  for (let index = 0; index < count; index += 1) {
    times.push(Number(Math.min(endTime, Math.max(0, step * index)).toFixed(3)));
  }
  return uniqueBy(times, (time) => time.toFixed(3));
}

function limitCaptureTimes(times, maxFrames) {
  if (!maxFrames || times.length <= maxFrames) return times;
  if (maxFrames <= 1) return [times[0]];
  const limited = [];
  for (let index = 0; index < maxFrames; index += 1) {
    const sourceIndex = Math.round((times.length - 1) * (index / (maxFrames - 1)));
    limited.push(times[sourceIndex]);
  }
  return uniqueBy(limited, (time) => time.toFixed(3));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

async function seekAndDrawFrame(video, time, canvas, ctx) {
  if (video.readyState < 2 || Math.abs(video.currentTime - time) >= 0.05) {
    await seekVideo(video, time, 8000);
  }
  // Once "seeked" fires the frame at the new position is drawable; do NOT wait on
  // requestVideoFrameCallback here — offscreen documents never composite, so it
  // never fires and each frame would stall until its timeout (~1s/frame).
  if (video.readyState < 2) {
    await waitForMediaEvent(video, ["canplay", "loadeddata", "seeked"], 1000);
  }

  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 360;
  const scale = Math.min(1, VIDEO_FRAME_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.drawImage(video, 0, 0, width, height);

  const timestamp = formatTimestamp(time);
  const dataUrl = await canvasToJpegDataUrl(canvas, VIDEO_FRAME_JPEG_QUALITY);
  if (!dataUrl) return null;
  return {
    dataUrl,
    mimeType: "image/jpeg",
    label: `video frame ${timestamp}`,
    timestampSeconds: time,
    timestamp,
    width,
    height
  };
}

function canvasToJpegDataUrl(canvas, quality) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(canvas.toDataURL("image/jpeg", quality));
      return;
    }
    canvas.toBlob(async (blob) => {
      if (!blob) {
        resolve(canvas.toDataURL("image/jpeg", quality));
        return;
      }
      try {
        resolve(await blobToDataUrl(blob));
      } catch {
        resolve(canvas.toDataURL("image/jpeg", quality));
      }
    }, "image/jpeg", quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read JPEG blob."));
    reader.readAsDataURL(blob);
  });
}

function waitForVideoReady(video, timeoutMs) {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for raw video to load.")), timeoutMs);
    const finish = (error) => {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
      error ? reject(error) : resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error(video.error?.message || "Raw video failed to load."));
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function seekVideo(video, time, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      if (timeout) clearTimeout(timeout);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error(video.error?.message || "Video seek failed."));

    if (Math.abs(video.currentTime - time) < 0.05) {
      resolve();
      return;
    }

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    timeout = setTimeout(() => finish(new Error("Timed out seeking raw video.")), timeoutMs);
    try {
      // Sparse analysis does not need sample-accurate seeks; fastSeek jumps to a nearby keyframe.
      if (typeof video.fastSeek === "function") {
        video.fastSeek(time);
      } else {
        video.currentTime = time;
      }
    } catch (error) {
      finish(error);
    }
  });
}

function waitForMediaEvent(media, eventNames, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      eventNames.forEach((eventName) => media.removeEventListener(eventName, done));
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(done, timeoutMs);
    eventNames.forEach((eventName) => media.addEventListener(eventName, done, { once: true }));
  });
}

async function fetchMediaBlob(mediaUrl, captureId, label) {
  await reportCaptureProgress(captureId, `Downloading ${label}...`);
  const response = await fetch(mediaUrl, { credentials: "omit" });
  if (!response.ok) throw new Error(`${label} fetch failed: ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_CAPTURE_VIDEO_BYTES) throw new Error(`${label} was too large to capture as a blob.`);
  if (contentLength > 0) {
    await reportCaptureProgress(captureId, `Downloading ${label} (${formatBytes(contentLength)})...`, {
      bytes: contentLength
    });
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error(`${label} fetch returned an empty file.`);
  if (blob.size > MAX_CAPTURE_VIDEO_BYTES) throw new Error(`${label} was too large to capture as a blob.`);
  await reportCaptureProgress(captureId, `Downloaded ${label} (${formatBytes(blob.size)}).`, {
    bytes: blob.size
  });
  return blob;
}

async function reportCaptureProgress(captureId, message, detail = null) {
  if (!captureId || !message) return;
  try {
    await api.runtime.sendMessage({
      type: "ASKLOCAL_VIDEO_CAPTURE_PROGRESS",
      payload: {
        captureId,
        message,
        detail
      }
    });
  } catch {
    // Progress is best-effort; frame capture can continue without it.
  }
}

function isCanvasAccessError(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("taint") || text.includes("cross-origin") || text.includes("insecure");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function formatTimestamp(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const totalTenths = Math.round(seconds * 10);
  const whole = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}${tenths ? `.${tenths}` : ""}`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
