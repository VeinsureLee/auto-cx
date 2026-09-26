import assert from "node:assert/strict";
import test from "node:test";

import {
  hasReachedMediaTarget,
  mediaTargetSeconds,
  waitForMediaEnd,
  waitForMediaTarget,
  waitForMediaTaskCompletion,
} from "../src/task-point.mjs";

function createMediaFrame(states) {
  let elapsedMs = 0;
  let readIndex = 0;
  const media = {
    async count() {
      return 1;
    },
    async evaluate() {
      const state = states[Math.min(readIndex, states.length - 1)];
      readIndex += 1;
      return state;
    },
  };

  return {
    frame: {
      locator() {
        return {
          first() {
            return media;
          },
        };
      },
      async waitForTimeout(milliseconds) {
        elapsedMs += milliseconds;
      },
    },
    now() {
      return elapsedMs;
    },
  };
}

test("waitForMediaEnd does not use the page timeout as the media duration limit", async () => {
  const states = Array.from({ length: 41 }, (_, currentTime) => ({
    currentTime,
    duration: 120,
    ended: false,
    paused: false,
    readyState: 4,
  }));
  states.push({ currentTime: 120, duration: 120, ended: true, paused: true, readyState: 4 });
  const fake = createMediaFrame(states);

  const result = await waitForMediaEnd(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    stallTimeoutMs: 60_000,
  });

  assert.equal(result.status, "watched");
  assert.equal(result.state.ended, true);
  assert.ok(fake.now() > 30_000);
});

test("waitForMediaEnd still bounds the wait for missing metadata", async () => {
  const fake = createMediaFrame([
    { currentTime: 0, duration: null, ended: false, paused: true, readyState: 0 },
  ]);

  const result = await waitForMediaEnd(fake.frame, "video", 3_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
  });

  assert.deepEqual(result, { status: "error", detail: "等待媒体元数据加载超时" });
  assert.equal(fake.now(), 3_000);
});

test("waitForMediaEnd reports playback that stops making progress", async () => {
  const fake = createMediaFrame([
    { currentTime: 8, duration: 120, ended: false, paused: false, readyState: 4 },
  ]);

  const result = await waitForMediaEnd(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    stallTimeoutMs: 3_000,
  });

  assert.deepEqual(result, { status: "error", detail: "媒体播放进度持续 3 秒未变化" });
  assert.equal(fake.now(), 3_000);
});

test("waitForMediaEnd lets onTick handle an in-video quiz and keeps waiting", async () => {
  const states = [
    { currentTime: 5, duration: 120, ended: false, paused: true, readyState: 4 },
    { currentTime: 6, duration: 120, ended: false, paused: false, readyState: 4 },
    { currentTime: 7, duration: 120, ended: false, paused: false, readyState: 4 },
    { currentTime: 120, duration: 120, ended: true, paused: true, readyState: 4 },
  ];
  const fake = createMediaFrame(states);

  let onTickCalls = 0;
  const result = await waitForMediaEnd(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    stallTimeoutMs: 60_000,
    onTick: async () => {
      onTickCalls += 1;
      return onTickCalls === 1; // 只在第一次出现测验时“处理”
    },
  });

  assert.equal(result.status, "watched");
  assert.equal(result.state.ended, true);
  assert.ok(onTickCalls >= 1, "onTick should be invoked");
});

test("media target helpers use the configured percentage without seeking", () => {
  assert.equal(mediaTargetSeconds(200, 95), 190);
  assert.equal(mediaTargetSeconds(200, 0.95), 190);
  assert.equal(mediaTargetSeconds(200, 1), 2);
  assert.equal(
    hasReachedMediaTarget({ currentTime: 189.99, duration: 200, ended: false }, 95),
    false,
  );
  assert.equal(
    hasReachedMediaTarget({ currentTime: 190, duration: 200, ended: false }, 95),
    true,
  );
});

// 同时模拟媒体进度与任务点完成状态：readTaskPoint 每次轮询推进一次任务点状态。
function createFakeTaskPointFrame({ mediaStates, taskStates }) {
  const fake = createMediaFrame(mediaStates);
  let taskReadIndex = 0;
  return {
    frame: fake.frame,
    now: fake.now,
    async readTaskPoint() {
      const state = taskStates[Math.min(taskReadIndex, taskStates.length - 1)];
      taskReadIndex += 1;
      return { state, conditionText: "fake", source: "fake-task-point" };
    },
  };
}

test("media completion defaults to natural 100 percent", async () => {
  const fake = createMediaFrame([
    { currentTime: 95, duration: 100, ended: false, paused: false, readyState: 4 },
    { currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 },
  ]);
  const result = await waitForMediaTarget(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
  });
  assert.equal(result.status, "reached_target");
  assert.equal(result.targetSeconds, 100);
});

test("task-point completed can finish before natural end", async () => {
  const fake = createFakeTaskPointFrame({
    mediaStates: [{ currentTime: 50, duration: 100, ended: false, paused: false, readyState: 4 }],
    taskStates: ["completed"],
  });
  const result = await waitForMediaTaskCompletion(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    readTaskPoint: fake.readTaskPoint,
  });
  assert.equal(result.status, "task_completed");
  assert.equal(result.state.currentTime, 50);
  assert.equal(result.taskPointState.state, "completed");
});

test("pending task-point after end waits then fails", async () => {
  const fake = createFakeTaskPointFrame({
    mediaStates: [{ currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 }],
    taskStates: ["pending", "pending", "pending"],
  });
  const result = await waitForMediaTaskCompletion(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    completionSyncTimeoutMs: 2_000,
    readTaskPoint: fake.readTaskPoint,
  });
  assert.equal(result.status, "error");
  assert.equal(result.detail, "视频已播放结束但任务点仍未完成");
  assert.equal(result.taskPointState.state, "pending");
});

test("unavailable task-point at natural end resolves as reached target", async () => {
  const fake = createFakeTaskPointFrame({
    mediaStates: [{ currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 }],
    taskStates: ["unavailable"],
  });
  const result = await waitForMediaTaskCompletion(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    readTaskPoint: fake.readTaskPoint,
  });
  assert.equal(result.status, "reached_target");
  assert.equal(result.targetSeconds, 100);
  assert.equal(result.taskPointState.state, "unavailable");
});

test("waitForMediaTaskCompletion without a task reader waits for natural end", async () => {
  const fake = createMediaFrame([
    { currentTime: 40, duration: 100, ended: false, paused: false, readyState: 4 },
    { currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 },
  ]);
  const result = await waitForMediaTaskCompletion(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
  });
  assert.equal(result.status, "reached_target");
  assert.equal(result.state.ended, true);
  assert.equal(result.taskPointState.state, "unavailable");
});

test("media leaving the ended state resets the completion sync window", async () => {
  const fake = createFakeTaskPointFrame({
    mediaStates: [
      { currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 },
      { currentTime: 20, duration: 100, ended: false, paused: false, readyState: 4 },
      { currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 },
    ],
    taskStates: ["pending", "pending", "pending", "pending", "pending"],
  });
  const result = await waitForMediaTaskCompletion(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    completionSyncTimeoutMs: 2_000,
    readTaskPoint: fake.readTaskPoint,
  });
  assert.equal(result.status, "error");
  // 第 2 次轮询媒体离开 ended（重播），计时重置；第 3 次重新进入 ended 后再等 2 秒。
  assert.equal(fake.now(), 4_000);
});

test("waitForMediaTarget stops as soon as natural playback reaches 95 percent", async () => {
  const fake = createMediaFrame([
    { currentTime: 10, duration: 100, ended: false, paused: false, readyState: 4 },
    { currentTime: 94, duration: 100, ended: false, paused: false, readyState: 4 },
    { currentTime: 95, duration: 100, ended: false, paused: false, readyState: 4 },
  ]);
  const samples = [];

  const result = await waitForMediaTarget(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    targetPercent: 95,
    onSample: async (state) => samples.push(state.currentTime),
  });

  assert.equal(result.status, "reached_target");
  assert.equal(result.targetSeconds, 95);
  assert.equal(result.state.currentTime, 95);
  assert.deepEqual(samples, [10, 94, 95]);
});
