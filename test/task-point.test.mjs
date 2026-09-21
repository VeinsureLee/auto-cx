import assert from "node:assert/strict";
import test from "node:test";

import { waitForMediaEnd } from "../src/task-point.mjs";

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
