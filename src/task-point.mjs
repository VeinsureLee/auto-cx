const MEDIA_STALL_TIMEOUT_MS = 60_000;
const MEDIA_POLL_INTERVAL_MS = 1_500;
const MEDIA_PROGRESS_EPSILON_SECONDS = 0.05;

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

export async function startMediaPlayback(frame, mediaType = "video") {
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
}
