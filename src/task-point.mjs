const MEDIA_STALL_TIMEOUT_MS = 60_000;
const MEDIA_POLL_INTERVAL_MS = 1_500;
const MEDIA_PROGRESS_EPSILON_SECONDS = 0.05;
// 媒体自然播放结束后，等待平台把任务点同步为“已完成”的上限时间。
const TASK_POINT_SYNC_TIMEOUT_MS = 15_000;

export function decideVideoEnded(state) {
  if (!state) {
    return false;
  }
  if (state.ended === true) {
    return true;
  }
  if (state.duration !== null && Number.isFinite(state.duration)) {
    return state.currentTime >= state.duration - 0.5;
  }
  return false;
}

export function mediaTargetSeconds(duration, targetPercent = 100) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  const ratio = targetPercent >= 1 ? targetPercent / 100 : targetPercent;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error(`媒体目标比例无效：${targetPercent}`);
  }
  return Number((duration * ratio).toFixed(2));
}

export function hasReachedMediaTarget(state, targetPercent = 100) {
  if (!state || !Number.isFinite(state.currentTime)) {
    return false;
  }
  const target = mediaTargetSeconds(state.duration, targetPercent);
  if (target === null) {
    return false;
  }
  const ratio = targetPercent >= 1 ? targetPercent / 100 : targetPercent;
  if (ratio >= 1) {
    return decideVideoEnded(state);
  }
  return state.currentTime >= target;
}

export async function readMediaState(frame, mediaType = "video") {
  const media = frame.locator(mediaType).first();
  if ((await media.count()) === 0) {
    return null;
  }
  return media.evaluate((element) => ({
    currentTime: Number(element.currentTime.toFixed(2)),
    duration: Number.isFinite(element.duration) ? Number(element.duration.toFixed(2)) : null,
    ended: element.ended,
    paused: element.paused,
    readyState: element.readyState,
  }));
}

export async function waitForMediaTarget(frame, mediaType, metadataTimeoutMs, options = {}) {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? MEDIA_POLL_INTERVAL_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? MEDIA_STALL_TIMEOUT_MS;
  const targetPercent = options.targetPercent ?? 100;
  const speed = options.speed ?? 1;
  const metadataDeadline = now() + metadataTimeoutMs;
  let lastCurrentTime = null;
  let lastProgressAt = now();

  while (true) {
    // 处理视频播放中弹出的内嵌测验等：处理完成后重置进度计时，继续等待播放。
    if (typeof options.onTick === "function") {
      const handled = await options.onTick();
      if (handled) {
        lastCurrentTime = null;
        lastProgressAt = now();
        await frame.waitForTimeout(pollIntervalMs);
        continue;
      }
    }

    const state = await readMediaState(frame, mediaType);
    const sampledAt = now();
    if (speed !== 1) {
      // 持续保持倍速，避免平台/播放器把 playbackRate 重置回 1。
      await frame
        .locator(mediaType)
        .first()
        .evaluate((element, rate) => {
          if (element.playbackRate !== rate) {
            element.playbackRate = rate;
          }
        }, speed)
        .catch(() => {});
    }
    if (state === null || !state.duration || state.duration <= 0) {
      if (sampledAt >= metadataDeadline) {
        return { status: "error", detail: "等待媒体元数据加载超时" };
      }
      await frame.waitForTimeout(Math.min(1_000, pollIntervalMs));
      continue;
    }
    const targetSeconds = mediaTargetSeconds(state.duration, targetPercent);
    if (typeof options.onSample === "function") {
      await options.onSample(state, { targetSeconds });
    }
    if (hasReachedMediaTarget(state, targetPercent)) {
      return { status: "reached_target", state, targetSeconds };
    }

    const progressed =
      lastCurrentTime === null ||
      state.currentTime > lastCurrentTime + MEDIA_PROGRESS_EPSILON_SECONDS ||
      state.currentTime < lastCurrentTime - 1;
    if (progressed) {
      lastCurrentTime = state.currentTime;
      lastProgressAt = sampledAt;
    }

    if (sampledAt - lastProgressAt >= stallTimeoutMs) {
      if (state.paused) {
        return {
          status: "skipped",
          detail: `媒体已暂停且持续超过 ${Math.round(stallTimeoutMs / 1_000)} 秒，未自动续播`,
        };
      }
      return {
        status: "error",
        detail: `媒体播放进度持续 ${Math.round(stallTimeoutMs / 1_000)} 秒未变化`,
      };
    }

    await frame.waitForTimeout(pollIntervalMs);
  }
}

export async function waitForMediaTaskCompletion(frame, mediaType, metadataTimeoutMs, options = {}) {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? MEDIA_POLL_INTERVAL_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? MEDIA_STALL_TIMEOUT_MS;
  const completionSyncTimeoutMs = options.completionSyncTimeoutMs ?? TASK_POINT_SYNC_TIMEOUT_MS;
  const speed = options.speed ?? 1;
  const readTaskPoint = options.readTaskPoint ?? null;
  const metadataDeadline = now() + metadataTimeoutMs;
  let lastCurrentTime = null;
  let lastProgressAt = now();
  let endedAt = null;
  let lastTaskPointState = null;

  while (true) {
    // 处理视频播放中弹出的内嵌测验等：处理完成后重置进度计时，继续等待播放。
    if (typeof options.onTick === "function") {
      const handled = await options.onTick();
      if (handled) {
        lastCurrentTime = null;
        lastProgressAt = now();
        await frame.waitForTimeout(pollIntervalMs);
        continue;
      }
    }

    const state = await readMediaState(frame, mediaType);
    const sampledAt = now();
    if (speed !== 1) {
      // 持续保持倍速，避免平台/播放器把 playbackRate 重置回 1。
      await frame
        .locator(mediaType)
        .first()
        .evaluate((element, rate) => {
          if (element.playbackRate !== rate) {
            element.playbackRate = rate;
          }
        }, speed)
        .catch(() => {});
    }
    if (state === null || !state.duration || state.duration <= 0) {
      if (sampledAt >= metadataDeadline) {
        return { status: "error", detail: "等待媒体元数据加载超时" };
      }
      await frame.waitForTimeout(Math.min(1_000, pollIntervalMs));
      continue;
    }
    const targetSeconds = mediaTargetSeconds(state.duration, 100);
    if (typeof options.onSample === "function") {
      await options.onSample(state, { targetSeconds });
    }

    // 任务点只读取 DOM 状态，绝不主动 seek/设置 currentTime，仅以自然播放为准。
    const taskPointState = readTaskPoint
      ? await readTaskPoint()
      : { state: "unavailable", conditionText: "", source: "no-task-reader" };

    const naturalEnd = decideVideoEnded(state);
    if (taskPointState.state === "completed") {
      // 平台已判定任务点完成，可以提前结束，无需等待自然播完。
      return { status: "task_completed", state, targetSeconds, taskPointState };
    }
    if (naturalEnd) {
      if (endedAt === null) {
        endedAt = sampledAt;
      }
      if (lastTaskPointState !== null && lastTaskPointState !== taskPointState.state) {
        // 任务点状态变化时重置同步计时，重新等一个完整的同步窗口。
        endedAt = sampledAt;
      }
      if (taskPointState.state === "unavailable") {
        // 无法读取任务点状态：退回自然播完即成功的兼容语义。
        return { status: "reached_target", state, targetSeconds, taskPointState };
      }
      if (sampledAt - endedAt >= completionSyncTimeoutMs) {
        return {
          status: "error",
          detail: "视频已播放结束但任务点仍未完成",
          state,
          targetSeconds,
          taskPointState,
        };
      }
    } else if (endedAt !== null) {
      // 媒体离开结束状态（如重播），同步计时作废。
      endedAt = null;
    }
    lastTaskPointState = taskPointState.state;

    const progressed =
      lastCurrentTime === null ||
      state.currentTime > lastCurrentTime + MEDIA_PROGRESS_EPSILON_SECONDS ||
      state.currentTime < lastCurrentTime - 1;
    if (progressed) {
      lastCurrentTime = state.currentTime;
      lastProgressAt = sampledAt;
    }

    if (sampledAt - lastProgressAt >= stallTimeoutMs) {
      if (state.paused) {
        return {
          status: "skipped",
          detail: `媒体已暂停且持续超过 ${Math.round(stallTimeoutMs / 1_000)} 秒，未自动续播`,
          taskPointState,
        };
      }
      return {
        status: "error",
        detail: `媒体播放进度持续 ${Math.round(stallTimeoutMs / 1_000)} 秒未变化`,
        taskPointState,
      };
    }

    await frame.waitForTimeout(pollIntervalMs);
  }
}

export async function waitForMediaEnd(frame, mediaType, metadataTimeoutMs, options = {}) {
  const result = await waitForMediaTarget(frame, mediaType, metadataTimeoutMs, {
    ...options,
    targetPercent: 100,
  });
  if (result.status === "reached_target") {
    return { status: "watched", state: result.state };
  }
  return result;
}

export async function waitForMediaReady(frame, mediaType, timeoutMs = 15_000) {
  const media = frame.locator(mediaType).first();
  await media.waitFor({ state: "attached", timeout: timeoutMs });
}

export async function startMediaPlayback(frame, mediaType = "video", { speed = 1 } = {}) {
  await waitForMediaReady(frame, mediaType);
  const media = frame.locator(mediaType).first();

  if (mediaType === "video") {
    const playButton = frame
      .locator(".vjs-big-play-button, button[title='播放视频'], .vjs-play-control.vjs-paused")
      .first();
    if ((await playButton.count()) > 0 && (await playButton.isVisible().catch(() => false))) {
      await playButton.click().catch(() => null);
    }
  }

  const state = await readMediaState(frame, mediaType);
  if (!state || state.paused) {
    await media.evaluate((element) => element.play?.().catch(() => {})).catch(() => {});
  }

  if (speed !== 1) {
    await media
      .evaluate((element, rate) => {
        element.playbackRate = rate;
      }, speed)
      .catch(() => {});
  }
}
