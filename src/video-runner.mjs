import { handleVideoQuizWork, isVideoQuizVisible } from "./quiz.mjs";
import { STUDY_SELECTORS } from "./study-selectors.mjs";
import { startMediaPlayback, waitForMediaTarget } from "./task-point.mjs";

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
  onProgress = async () => {},
  onPopupQuiz = async () => {},
}) {
  await startMediaPlayback(frame, "video", { speed: config.videoSpeed });
  let popupAttempts = 0;

  const result = await waitForMediaTarget(frame, "video", config.timeoutMs, {
    targetPercent: config.videoTargetPercent,
    speed: config.videoSpeed,
    onSample: onProgress,
    onTick: async () => {
      if (!(await isVideoQuizVisible(frame))) {
        return false;
      }
      if (popupAttempts >= STUDY_SELECTORS.videoQuiz.maxAttempts) {
        throw new VideoPlaybackError("视频弹题连续出现且超过处理上限", { blocked: true });
      }

      popupAttempts += 1;
      const quizResult = await handleVideoQuizWork({ frame, config }).catch((error) => ({
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
      return true;
    },
  });

  if (result.status !== "reached_target") {
    throw new VideoPlaybackError(result.detail || "视频未达到目标进度", {
      blocked: result.status === "skipped",
    });
  }
  return result;
}
