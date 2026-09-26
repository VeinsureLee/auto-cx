import assert from "node:assert/strict";
import test from "node:test";

import {
  StudyProgress,
  formatMediaTime,
  formatProgressBar,
} from "../src/study-progress.mjs";

test("formatMediaTime renders finite media seconds", () => {
  assert.equal(formatMediaTime(0), "00:00");
  assert.equal(formatMediaTime(65.8), "01:05");
  assert.equal(formatMediaTime(3_661), "1:01:01");
  assert.equal(formatMediaTime(null), "--:--");
});

test("formatProgressBar clamps target progress and keeps a fixed width", () => {
  assert.deepEqual(formatProgressBar(47.5, 95, 10), {
    percent: 50,
    text: "[█████░░░░░]",
  });
  assert.deepEqual(formatProgressBar(100, 95, 10), {
    percent: 100,
    text: "[██████████]",
  });
  assert.deepEqual(formatProgressBar(-5, 95, 10), {
    percent: 0,
    text: "[░░░░░░░░░░]",
  });
});

function memoryStream(isTTY) {
  let output = "";
  return {
    isTTY,
    columns: 120,
    write(chunk) {
      output += String(chunk);
      return true;
    },
    output: () => output,
  };
}

// Minimal ANSI screen emulator: reconstructs the visible terminal contents so a
// test can prove stale lines are actually cleared on redraw.
function screenFrom(output) {
  const lines = [""];
  let row = 0;
  let index = 0;
  while (index < output.length) {
    if (output.startsWith("\u001b[", index)) {
      const rest = output.slice(index);
      const up = rest.match(/^\u001b\[(\d*)A/);
      if (up) {
        row = Math.max(0, row - Number(up[1] || 1));
        index += up[0].length;
        continue;
      }
      const clear = rest.match(/^\u001b\[2K/);
      if (clear) {
        lines[row] = "";
        index += clear[0].length;
        continue;
      }
      const visibility = rest.match(/^\u001b\[\?25[hl]/);
      if (visibility) {
        index += visibility[0].length;
        continue;
      }
    }
    const char = output[index];
    if (char === "\n") {
      row += 1;
      if (lines[row] === undefined) lines[row] = "";
      index += 1;
      continue;
    }
    lines[row] = (lines[row] ?? "") + char;
    index += 1;
  }
  return lines;
}

test("StudyProgress renders one labeled progress row per active page in a TTY", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "科研诚信", total: 3, concurrency: 3 });
  progress.assign(1, { lessonTitle: "1.1 第一节" });
  progress.assign(2, { lessonTitle: "1.2 第二节" });
  progress.stage(1, { name: "video", taskTitle: "视频 1" });
  progress.video(1, { currentTime: 47.5, duration: 100, targetSeconds: 95, speed: 2 });
  progress.stage(2, { name: "homework", detail: "正在生成答案" });
  progress.stop();

  assert.match(stream.output(), /页面 1/);
  assert.match(stream.output(), /1\.1 第一节/);
  assert.match(stream.output(), /50%/);
  assert.match(stream.output(), /页面 2/);
  assert.match(stream.output(), /正在生成答案/);
});

test("StudyProgress emits only new ten-percent milestones outside a TTY", () => {
  const stream = memoryStream(false);
  const progress = new StudyProgress({ stream, errorStream: stream });
  progress.startCourse({ name: "科研诚信", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "1.1 第一节" });
  progress.video(1, { currentTime: 5, duration: 100, targetSeconds: 95, speed: 2 });
  progress.video(1, { currentTime: 9, duration: 100, targetSeconds: 95, speed: 2 });
  progress.video(1, { currentTime: 10, duration: 100, targetSeconds: 95, speed: 2 });
  progress.video(1, { currentTime: 11, duration: 100, targetSeconds: 95, speed: 2 });
  progress.stop();

  const milestones = stream.output().match(/视频进度/g) ?? [];
  assert.equal(milestones.length, 2); // initial 0% bucket and the first 10% bucket
  assert.doesNotMatch(stream.output(), /\u001b\[/);
});

test("StudyProgress redraw clears stale line content when a slot shrinks", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "课程", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "很长的旧课节标题" });
  progress.assign(1, { lessonTitle: "新标题" });
  progress.stop();

  const screen = screenFrom(stream.output()).join("\n");
  assert.match(screen, /新标题/);
  assert.doesNotMatch(screen, /旧课节标题/);
});

test("StudyProgress records SIGINT as orderly cancellation instead of terminating the process", () => {
  const stream = memoryStream(true);
  let receivedSignal = null;
  const progress = new StudyProgress({
    stream,
    errorStream: stream,
    redrawIntervalMs: 0,
    onSignal: (signal) => { receivedSignal = signal; },
  });

  progress.requestStop("SIGINT");

  assert.equal(receivedSignal, "SIGINT");
  assert.equal(progress.interrupted, true);
  assert.match(progress.interruptionError.message, /SIGINT/);
  assert.equal((stream.output().match(/\u001b\[\?25h/g) ?? []).length, 1);
  progress.stop();
  assert.equal((stream.output().match(/\u001b\[\?25h/g) ?? []).length, 1);
});

test("StudyProgress stop is idempotent and restores the cursor once", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "课程", total: 1, concurrency: 1 });
  progress.stop();
  progress.stop();

  assert.equal((stream.output().match(/\u001b\[\?25h/g) ?? []).length, 1);
});

test("StudyProgress clamps each TTY row to the available terminal columns", () => {
  const stream = memoryStream(true);
  stream.columns = 24;
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "课程名称很长很长很长很长很长", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "一个非常非常长的课节标题，不能让终端换行" });
  progress.stage(1, { name: "homework", detail: "这是一个特别长的作业处理详情文本" });

  assert.ok(progress.buildLines().every((line) => line.length <= 24));
  progress.stop();
});

test("StudyProgress video updates accept task-point state alongside media percent", () => {
  const stream = memoryStream(false);
  const progress = new StudyProgress({ stream, errorStream: stream });
  progress.startCourse({ name: "课程", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "1.1 第一节" });
  // 媒体到 100% 时任务点仍可能未完成：任务点状态与媒体百分比分开传递，
  // pending 不得因媒体满格而被当成已完成。
  progress.video(1, { currentTime: 100, duration: 100, targetSeconds: 100, speed: 2, taskPointState: "pending" });
  progress.video(1, { currentTime: 100, duration: 100, targetSeconds: 100, speed: 2, taskPointState: "completed" });
  progress.video(1, { currentTime: 100, duration: 100, targetSeconds: 100, speed: 2, taskPointState: "unavailable" });
  progress.stop();

  assert.match(stream.output(), /视频进度 100%/);
  assert.doesNotMatch(stream.output(), /\u001b\[/);
});

test("StudyProgress shows popup quiz and homework retry stages for a page", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "课程", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "1.1 标题" });
  progress.stage(1, { name: "video-quiz", detail: "正在处理视频弹题" });
  progress.stage(1, { name: "homework", detail: "正在生成答案" });
  progress.stage(1, { name: "homework-retry", detail: "第 2/3 次尝试" });
  progress.finish(1, { status: "failed", detail: "作业失败" });
  progress.stop();

  assert.match(stream.output(), /正在处理视频弹题/);
  assert.match(stream.output(), /正在生成答案/);
  assert.match(stream.output(), /第 2\/3 次尝试/);
  assert.match(stream.output(), /作业失败/);
});
