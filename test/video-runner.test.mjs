import assert from "node:assert/strict";
import test from "node:test";

import { playManifestVideo } from "../src/video-runner.mjs";

test("playManifestVideo reports popup quiz handling before and result after quiz work", async () => {
  const order = [];
  const popupCalls = [];

  const deps = {
    startMediaPlayback: async () => {
      order.push("start");
    },
    waitForMediaTarget: async (frame, mediaType, timeoutMs, options) => {
      order.push("wait");
      await options.onTick();
      return {
        status: "reached_target",
        state: { currentTime: 95, duration: 100 },
        targetSeconds: 95,
      };
    },
    isVideoQuizVisible: async () => {
      order.push("visible");
      return true;
    },
    handleVideoQuizWork: async () => {
      order.push("work");
      return { status: "answered", detail: "视频内题目已作答", answers: [] };
    },
  };

  await playManifestVideo({
    frame: {},
    config: { videoSpeed: 1, timeoutMs: 1_000, videoTargetPercent: 100 },
    onPopupQuiz: async (result) => {
      popupCalls.push(result);
    },
    deps,
  });

  assert.deepEqual(popupCalls, [
    { status: "handling", detail: "正在处理视频弹题" },
    { status: "answered", detail: "视频内题目已作答", answers: [] },
  ]);
  assert.deepEqual(order, ["start", "wait", "visible", "work"]);
});
