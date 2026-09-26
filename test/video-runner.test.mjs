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
    waitForMediaTaskCompletion: async (frame, mediaType, timeoutMs, options) => {
      order.push("wait");
      assert.equal(mediaType, "video");
      assert.equal(timeoutMs, 1_000);
      assert.equal(options.targetPercent, undefined, "legacy videoTargetPercent must not reach the normal runner");
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
    { status: "handling", sequence: 1, detail: "正在处理视频弹题" },
    { status: "answered", detail: "视频内题目已作答", answers: [] },
  ]);
  // 处理完成后还会确认一次弹题是否关闭，因此 isVideoQuizVisible 被调用两次。
  assert.deepEqual(order, ["start", "wait", "visible", "work", "visible"]);
});

test("playManifestVideo handles each distinct popup occurrence", async () => {
  const events = [];
  let visibleCalls = 0;
  await playManifestVideo({
    frame: {},
    config: { videoSpeed: 2, timeoutMs: 1_000 },
    onPopupQuiz: async (event) => events.push(event),
    deps: {
      startMediaPlayback: async () => {},
      isVideoQuizVisible: async () => ++visibleCalls % 2 === 1,
      handleVideoQuizWork: async () => ({ status: "answered", detail: "ok" }),
      waitForMediaTaskCompletion: async (_frame, _type, _timeout, options) => {
        await options.onTick();
        await options.onTick();
        return { status: "reached_target", state: { currentTime: 100, duration: 100 } };
      },
    },
  });
  assert.deepEqual(
    events.filter((event) => event.status === "handling").map((event) => event.sequence),
    [1, 2],
  );
});

test("playManifestVideo does not reprocess a popup that is still open", async () => {
  const events = [];
  const deps = {
    startMediaPlayback: async () => {},
    waitForMediaTaskCompletion: async (_frame, _type, _timeout, options) => {
      await options.onTick();
      await options.onTick();
      await options.onTick();
      return { status: "reached_target", state: { currentTime: 100, duration: 100 } };
    },
    isVideoQuizVisible: async () => true,
    handleVideoQuizWork: async () => ({ status: "answered", detail: "ok" }),
  };

  await playManifestVideo({
    frame: {},
    config: { videoSpeed: 1, timeoutMs: 1_000 },
    onPopupQuiz: async (event) => events.push(event),
    deps,
  });

  assert.deepEqual(
    events.filter((event) => event.status === "handling").map((event) => event.sequence),
    [1],
  );
});

test("playManifestVideo forwards task reader options and accepts task_completed", async () => {
  const seenOptions = [];
  const readTaskPoint = async () => ({ state: "completed", conditionText: "已完成", source: "icon" });
  const result = await playManifestVideo({
    frame: {},
    config: { videoSpeed: 1, timeoutMs: 1_000 },
    readTaskPoint,
    completionSyncTimeoutMs: 2_000,
    deps: {
      startMediaPlayback: async () => {},
      isVideoQuizVisible: async () => false,
      waitForMediaTaskCompletion: async (_frame, _type, _timeout, options) => {
        seenOptions.push(options);
        return {
          status: "task_completed",
          state: { currentTime: 50, duration: 100 },
          taskPointState: await options.readTaskPoint(),
        };
      },
    },
  });

  assert.equal(result.status, "task_completed");
  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0].readTaskPoint, readTaskPoint);
  assert.equal(seenOptions[0].completionSyncTimeoutMs, 2_000);
  assert.equal(seenOptions[0].speed, 1);
});

test("playManifestVideo throws blocked VideoPlaybackError when the wait cannot finish", async () => {
  for (const status of ["error", "skipped"]) {
    await assert.rejects(
      playManifestVideo({
        frame: {},
        config: { videoSpeed: 1, timeoutMs: 1_000 },
        deps: {
          startMediaPlayback: async () => {},
          isVideoQuizVisible: async () => false,
          waitForMediaTaskCompletion: async () => ({
            status,
            detail: status === "skipped" ? "媒体已暂停" : "等待超时",
          }),
        },
      }),
      (error) => {
        assert.equal(error.name, "VideoPlaybackError");
        assert.equal(error.blocked, status === "skipped");
        return true;
      },
    );
  }
});

test("playManifestVideo throws blocked VideoPlaybackError when popup quiz work fails", async () => {
  await assert.rejects(
    playManifestVideo({
      frame: {},
      config: { videoSpeed: 1, timeoutMs: 1_000 },
      deps: {
        startMediaPlayback: async () => {},
        isVideoQuizVisible: async () => true,
        handleVideoQuizWork: async () => ({
          status: "skipped",
          detail: "视频内题目所有选项均尝试失败，未能通过",
          answers: [],
        }),
        waitForMediaTaskCompletion: async (_frame, _type, _timeout, options) => {
          await options.onTick();
          return { status: "reached_target", state: { currentTime: 100, duration: 100 } };
        },
      },
    }),
    (error) => {
      assert.equal(error.name, "VideoPlaybackError");
      assert.equal(error.blocked, true);
      assert.equal(error.message, "视频内题目所有选项均尝试失败，未能通过");
      return true;
    },
  );
});
