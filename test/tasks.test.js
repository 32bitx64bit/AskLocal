import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configureLanes, describeTasks, resetTasksForTests, runTask, withLane } from "../src/background/orchestrator/tasks.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
beforeEach(() => resetTasksForTests());

test("callers asking for the same key share one run", async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    await tick();
    return "done";
  };
  const [a, b] = await Promise.all([runTask("k", { run }), runTask("k", { run })]);
  assert.equal(runs, 1);
  assert.equal(a, "done");
  assert.equal(b, "done");
});

test("lanes cap concurrency and release slots", async () => {
  configureLanes({ vision: 2 });
  let active = 0;
  let peak = 0;
  const job = () => withLane("vision", async () => {
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
  });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
  assert.equal(describeTasks().lanes.vision.active, 0);
});

test("a caller leaving aborts the task only when nobody else waits and it is not background", async () => {
  let aborted = false;
  const run = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      resolve("aborted");
    });
    setTimeout(() => resolve("finished"), 30);
  });
  const leaving = new AbortController();
  const first = runTask("k", { run, signal: leaving.signal });
  const second = runTask("k", { run });
  leaving.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(await second, "finished");
  assert.equal(aborted, false);
});

test("background tasks keep running after every caller left", async () => {
  let finished = false;
  const caller = new AbortController();
  const waiting = runTask("bg", {
    background: true,
    signal: caller.signal,
    run: async () => {
      await tick(20);
      finished = true;
    }
  });
  caller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await tick(40);
  assert.equal(finished, true);
});

test("a caller arriving after an abort starts a fresh run", async () => {
  let runs = 0;
  const run = ({ signal }) => new Promise((resolve, reject) => {
    runs += 1;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })));
    setTimeout(() => resolve(`run ${runs}`), 15);
  });
  const caller = new AbortController();
  const first = runTask("k", { run, signal: caller.signal });
  caller.abort();
  await assert.rejects(first);
  assert.equal(await runTask("k", { run }), "run 2");
});

test("progress reaches every joined caller", async () => {
  const seen = { a: [], b: [] };
  const run = async ({ progress }) => {
    await tick();
    progress("halfway");
    await tick();
    return 1;
  };
  await Promise.all([
    runTask("p", { run, onProgress: (m) => seen.a.push(m) }),
    runTask("p", { run, onProgress: (m) => seen.b.push(m) })
  ]);
  assert.deepEqual(seen.a, ["halfway"]);
  assert.deepEqual(seen.b, ["halfway"]);
});

test("waiting for a lane slot stops when the caller aborts", async () => {
  configureLanes({ text: 1 });
  let release;
  const holder = withLane("text", () => new Promise((resolve) => { release = resolve; }));
  const caller = new AbortController();
  const queued = withLane("text", async () => "ran", caller.signal);
  caller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  release();
  await holder;
  assert.equal(await withLane("text", async () => "next"), "next");
});
