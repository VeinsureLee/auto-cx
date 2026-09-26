import process from "node:process";

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const DEFAULT_BAR_WIDTH = 20;
const DEFAULT_REDRAW_INTERVAL_MS = 100;

const STAGE_LABELS = new Map([
  ["open", "打开页面"],
  ["tasks", "发现任务"],
  ["video", "视频播放"],
  ["video-quiz", "视频弹题"],
  ["homework", "作业"],
  ["homework-retry", "作业重试"],
  ["submit", "提交"],
  ["done", "完成"],
  ["failed", "失败"],
  ["locked", "已锁定"],
]);

const STATUS_ICONS = new Map([
  ["running", "▶"],
  ["done", "✓"],
  ["failed", "✗"],
  ["locked", "🔒"],
]);

/**
 * Render a media timestamp. Non-finite or negative values render as "--:--".
 * Durations under an hour use "MM:SS"; longer durations use "H:MM:SS".
 */
export function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  const paddedSeconds = String(secs).padStart(2, "0");
  if (hours > 0) return `${hours}:${paddedMinutes}:${paddedSeconds}`;
  return `${paddedMinutes}:${paddedSeconds}`;
}

/**
 * Compute progress toward a configured target and render a fixed-width bar.
 * Progress is clamped to 0-100 so reaching the target shows a full bar.
 */
export function formatProgressBar(current, target, width = DEFAULT_BAR_WIDTH) {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : DEFAULT_BAR_WIDTH;
  const value = Number.isFinite(current) ? current : 0;
  const ratio = Number.isFinite(target) && target > 0 ? value / target : 0;
  const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  const filled = Math.round((percent / 100) * safeWidth);
  const text = `[${"█".repeat(filled)}${"░".repeat(safeWidth - filled)}]`;
  return { percent, text };
}

function createWorkerState() {
  return {
    lessonTitle: null,
    stage: null,
    taskTitle: null,
    detail: null,
    currentTime: null,
    duration: null,
    targetSeconds: null,
    speed: null,
    status: "running",
    lastMilestone: -1,
    doneCounted: false,
  };
}

/**
 * Unified terminal progress controller. Business code reports events instead of
 * writing directly to the terminal. TTY streams get an in-place redraw region;
 * redirected streams get newline logs and ten-percent video milestones.
 */
export class StudyProgress {
  constructor({
    stream = process.stdout,
    errorStream = process.stderr,
    redrawIntervalMs = DEFAULT_REDRAW_INTERVAL_MS,
  } = {}) {
    this.stream = stream;
    this.errorStream = errorStream;
    this.redrawIntervalMs = Number.isFinite(redrawIntervalMs)
      ? Math.max(0, redrawIntervalMs)
      : DEFAULT_REDRAW_INTERVAL_MS;
    this.isTTY = Boolean(stream?.isTTY);

    this.courseName = null;
    this.courseTotal = 0;
    this.concurrency = 1;
    this.completed = 0;
    this.workers = new Map();
    this.renderedLines = 0;
    this.cursorHidden = false;
    this.stopped = false;
    this.renderTimer = null;
    this.signalHandlers = new Map(
      ["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
        this.stop();
        process.kill(process.pid, signal);
      }]),
    );
    for (const [signal, handler] of this.signalHandlers) process.once(signal, handler);
  }

  startCourse({ name, total, concurrency = 1 } = {}) {
    // Clear any region rendered for a previous course before its dimensions change.
    this.clearDynamic();
    this.courseName = name ?? null;
    this.courseTotal = Number.isFinite(total) ? total : 0;
    this.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
    this.completed = 0;
    this.workers = new Map();
    if (!this.isTTY && this.courseName) {
      this.stream.write(`课程：${this.courseName}（共 ${this.courseTotal} 节，并发 ${this.concurrency}）\n`);
    }
    this.requestRender({ force: true });
  }

  assign(slot, { lessonTitle } = {}) {
    const worker = this.workers.get(slot) ?? createWorkerState();
    worker.lessonTitle = lessonTitle ?? worker.lessonTitle;
    worker.status = "running";
    this.workers.set(slot, worker);
    if (!this.isTTY) {
      this.stream.write(`页面 ${slot} 领取课节：${worker.lessonTitle ?? "未知课节"}\n`);
    }
    this.requestRender({ force: true });
  }

  stage(slot, patch = {}) {
    const worker = this.workers.get(slot);
    if (!worker) return;
    const updates = [
      ["stage", patch.name],
      ["taskTitle", patch.taskTitle],
      ["detail", patch.detail],
    ].filter(([, value]) => value !== undefined);
    let changed = false;
    for (const [key, value] of updates) {
      if (worker[key] !== value) {
        worker[key] = value;
        changed = true;
      }
    }
    if (!changed) return;
    if (!this.isTTY) {
      const label = STAGE_LABELS.get(worker.stage) ?? worker.stage ?? "更新";
      const extra = worker.detail ?? worker.taskTitle ?? "";
      this.stream.write(`页面 ${slot} ${label}${extra ? `：${extra}` : ""}\n`);
    }
    this.requestRender({ force: true });
  }

  video(slot, { currentTime, duration, targetSeconds, speed } = {}) {
    const worker = this.workers.get(slot) ?? createWorkerState();
    if (Number.isFinite(currentTime)) worker.currentTime = currentTime;
    if (Number.isFinite(duration)) worker.duration = duration;
    if (Number.isFinite(targetSeconds)) worker.targetSeconds = targetSeconds;
    if (Number.isFinite(speed)) worker.speed = speed;
    this.workers.set(slot, worker);

    const { percent } = formatProgressBar(worker.currentTime, worker.targetSeconds);
    if (this.isTTY) {
      this.requestRender();
      return;
    }
    const milestone = Math.floor(percent / 10) * 10;
    if (milestone > worker.lastMilestone) {
      worker.lastMilestone = milestone;
      const time = formatMediaTime(worker.currentTime);
      const total = formatMediaTime(worker.duration);
      const speedText = Number.isFinite(worker.speed) ? `  ×${worker.speed}` : "";
      this.stream.write(`页面 ${slot} 视频进度 ${percent}%  ${time}/${total}${speedText}\n`);
    }
  }

  finish(slot, { status = "done", detail } = {}) {
    const worker = this.workers.get(slot);
    if (worker) {
      worker.status = status;
      if (detail !== undefined) worker.detail = detail;
      if (status === "done" && !worker.doneCounted) {
        worker.doneCounted = true;
        this.completed += 1;
      }
    }
    if (!this.isTTY) {
      const label = status === "done" ? "完成" : status === "locked" ? "已锁定" : "失败";
      const suffix = detail ? `：${detail}` : "";
      this.stream.write(`页面 ${slot} ${label}${suffix}\n`);
    }
    this.requestRender({ force: true });
  }

  release(slot) {
    if (this.workers.delete(slot)) {
      this.requestRender({ force: true });
    }
  }

  log(message) {
    this.writeMessage(this.stream, message);
  }

  warn(message) {
    this.writeMessage(this.errorStream, message);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.signalHandlers) {
      for (const [signal, handler] of this.signalHandlers) {
        process.removeListener(signal, handler);
      }
      this.signalHandlers.clear();
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.isTTY) {
      this.render();
      this.stream.write(SHOW_CURSOR);
      this.cursorHidden = false;
    } else if (this.courseName) {
      this.stream.write(`进度结束：已完成 ${this.completed}/${this.courseTotal} 节。\n`);
    }
  }

  writeMessage(target, message) {
    const text = `${message}\n`;
    if (!this.isTTY) {
      target.write(text);
      return;
    }
    this.clearDynamic();
    target.write(text);
    this.requestRender({ force: true });
  }

  clearDynamic() {
    if (!this.isTTY || this.renderedLines <= 0) {
      this.renderedLines = 0;
      return;
    }
    let text = `\u001b[${this.renderedLines}A`;
    for (let index = 0; index < this.renderedLines; index += 1) {
      text += "\u001b[2K\n";
    }
    this.stream.write(text);
    this.renderedLines = 0;
  }

  requestRender({ force = false } = {}) {
    if (!this.isTTY || this.stopped) return;
    if (force || this.redrawIntervalMs <= 0) {
      this.render();
      return;
    }
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, this.redrawIntervalMs);
    this.renderTimer.unref?.();
  }

  render() {
    const lines = this.buildLines();
    let text = "";
    if (!this.cursorHidden) {
      text += HIDE_CURSOR;
      this.cursorHidden = true;
    }
    const previous = this.renderedLines;
    if (previous > 0) text += `\u001b[${previous}A`;
    const count = Math.max(previous, lines.length);
    for (let index = 0; index < count; index += 1) {
      text += `\u001b[2K${lines[index] ?? ""}\n`;
    }
    this.stream.write(text);
    this.renderedLines = lines.length;
  }

  buildLines() {
    const active = [...this.workers.values()].filter(
      (worker) => worker.lessonTitle || worker.stage,
    ).length;
    const lines = [
      `${this.courseName ?? "未开始"}  并发 ${active}/${this.concurrency}  已完成 ${this.completed}/${this.courseTotal}`,
    ];
    for (let slot = 1; slot <= this.concurrency; slot += 1) {
      const worker = this.workers.get(slot);
      if (!worker || (!worker.lessonTitle && !worker.stage)) {
        lines.push(`页面 ${slot}  ⏳ 等待可执行课节`);
        continue;
      }
      const icon = STATUS_ICONS.get(worker.status) ?? "▶";
      lines.push(`页面 ${slot}  ${icon} ${worker.lessonTitle ?? "未知课节"}`);
      const stageLabel = STAGE_LABELS.get(worker.stage) ?? worker.stage ?? "处理中";
      const taskText = worker.taskTitle ? `：${worker.taskTitle}` : "";
      const detailText = worker.detail ? `  ${worker.detail}` : "";
      lines.push(`        ${stageLabel}${taskText}${detailText}`);
      const videoLine = this.buildVideoLine(worker);
      if (videoLine) lines.push(`        ${videoLine}`);
    }
    return lines;
  }

  buildVideoLine(worker) {
    const hasVideo = worker.currentTime !== null || worker.targetSeconds !== null;
    if (!hasVideo) return null;
    const { percent, text } = formatProgressBar(worker.currentTime, worker.targetSeconds);
    if (worker.status === "done" || percent >= 100) {
      return `${text} 视频已完成`;
    }
    if (worker.stage !== "video" && worker.stage !== "video-quiz" && !worker.detail) {
      return `${text} 视频已完成`;
    }
    const time = formatMediaTime(worker.currentTime);
    const total = formatMediaTime(worker.duration);
    const speedText = Number.isFinite(worker.speed) ? `  ×${worker.speed}` : "";
    return `${text} ${percent}%  ${time}/${total}${speedText}`;
  }
}
