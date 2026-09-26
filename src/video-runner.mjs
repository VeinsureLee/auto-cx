import { handleVideoQuizWork, isVideoQuizVisible } from "./assessment/video-popup.mjs";
import { startMediaPlayback, waitForMediaTaskCompletion } from "./task-point.mjs";

class VideoPlaybackError extends Error {
  constructor(message, { blocked = false } = {}) {
    super(message);
    this.name = "VideoPlaybackError";
    this.blocked = blocked;
  }
}

export async function playManifestVideo({
  frame,
  config,
  readTaskPoint = null,
  completionSyncTimeoutMs,
  onProgress = async () => {},
  onPopupQuiz = async () => {},
  deps = {},
}) {
  const {
    startMediaPlayback: runStartMediaPlayback = startMediaPlayback,
    waitForMediaTaskCompletion: runWaitForMediaTaskCompletion = waitForMediaTaskCompletion,
    isVideoQuizVisible: checkVideoQuizVisible = isVideoQuizVisible,
    handleVideoQuizWork: runHandleVideoQuizWork = handleVideoQuizWork,
  } = deps;

  await runStartMediaPlayback(frame, "video", { speed: config.videoSpeed });

  // 弹题序号只用于展示，不再限制整段视频的弹题总次数；
  // 单次弹题内的选项尝试次数仍由 handleVideoQuizWork 控制。
  let popupSequence = 0;
  let popupWasVisible = false;

  const waitOptions = {
    // 不再传 targetPercent：默认自然播到 100%，完成判定交给任务点状态。
    speed: config.videoSpeed,
    readTaskPoint,
    onSample: onProgress,
    onTick: async () => {
      const visible = await checkVideoQuizVisible(frame);
      if (!visible) {
        // 弹题已关闭：重置标记，下一次出现视为新的弹题。
        popupWasVisible = false;
        return false;
      }
      if (popupWasVisible) {
        // 同一弹题仍处于打开状态，避免重复处理。
        return false;
      }

      popupWasVisible = true;
      popupSequence += 1;
      await onPopupQuiz({
        status: "handling",
        sequence: popupSequence,
        detail: "正在处理视频弹题",
      });
      const quizResult = await runHandleVideoQuizWork({ frame, config }).catch((error) => ({
        status: "error",
        detail: error.message ?? String(error),
        answers: [],
      }));
      await onPopupQuiz(quizResult);
      if (quizResult.status === "error" || quizResult.status === "skipped") {
        throw new VideoPlaybackError(quizResult.detail || "视频弹题无法自动处理", {
          blocked: true,
        });
      }
      // 处理完成后确认弹题确实关闭，再重置标记以识别下一次弹题。
      if (!(await checkVideoQuizVisible(frame))) {
        popupWasVisible = false;
      }
      return true;
    },
  };
  if (completionSyncTimeoutMs !== undefined) {
    waitOptions.completionSyncTimeoutMs = completionSyncTimeoutMs;
  }

  const result = await runWaitForMediaTaskCompletion(frame, "video", config.timeoutMs, waitOptions);

  // 平台任务点已判定完成（task_completed）或自然播完（reached_target）均视为成功。
  if (result.status !== "task_completed" && result.status !== "reached_target") {
    throw new VideoPlaybackError(result.detail || "视频未达到目标进度", {
      blocked: result.status === "skipped",
    });
  }
  return result;
}
