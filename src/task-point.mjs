import { STUDY_SELECTORS } from "./study-selectors.mjs";
import { handleQuizWork } from "./quiz.mjs";

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

function frameModuleType(frame) {
  let pathname;
  try {
    pathname = new URL(frame.url()).pathname;
  } catch {
    return null;
  }
  for (const candidate of STUDY_SELECTORS.moduleFrames) {
    if (pathname.includes(candidate.path)) {
      return candidate.type;
    }
  }
  return null;
}

export async function detectTaskPointFrame(page) {
  const matches = [];
  for (const frame of page.frames()) {
    const type = frameModuleType(frame);
    if (type) {
      matches.push({ frame, type });
    }
  }
  if (matches.length === 0) {
    return null;
  }

  // 多个模块帧同时存在时，优先取可见者；否则取最后一个。
  for (const match of matches) {
    const element = await match.frame.frameElement().catch(() => null);
    if (element && (await element.isVisible().catch(() => false))) {
      return match;
    }
  }
  return matches[matches.length - 1];
}

export async function waitForMediaEnd(frame, mediaType, metadataTimeoutMs, options = {}) {
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? MEDIA_POLL_INTERVAL_MS;
  const stallTimeoutMs = options.stallTimeoutMs ?? MEDIA_STALL_TIMEOUT_MS;
  const metadataDeadline = now() + metadataTimeoutMs;
  let lastCurrentTime = null;
  let lastProgressAt = now();

  while (true) {
    const state = await readMediaState(frame, mediaType);
    const sampledAt = now();
    if (state === null || !state.duration || state.duration <= 0) {
      if (sampledAt >= metadataDeadline) {
        return { status: "error", detail: "等待媒体元数据加载超时" };
      }
      await frame.waitForTimeout(Math.min(1_000, pollIntervalMs));
      continue;
    }
    if (decideVideoEnded(state)) {
      return { status: "watched", state };
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

export async function waitForMediaReady(frame, mediaType) {
  const media = frame.locator(mediaType).first();
  await media.waitFor({ state: "attached", timeout: 15_000 });
}

function moduleFrameSignature(page) {
  return page
    .frames()
    .filter((frame) => frameModuleType(frame) !== null)
    .map((frame) => frame.url())
    .sort()
    .join("|");
}

async function waitForModuleChange(page, previousSignature, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (moduleFrameSignature(page) !== previousSignature) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function clickNextTaskPoint(page) {
  // 策略一：任务点列表，点击当前激活项的下一个兄弟
  for (const selector of STUDY_SELECTORS.taskPointList) {
    const items = page.locator(selector);
    const count = await items.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const active = await item
        .evaluate((element) => {
          const className = element.getAttribute("class") ?? "";
          return (
            element.classList.contains("active") ||
            element.classList.contains("cur") ||
            className.includes("active")
          );
        })
        .catch(() => false);
      if (active) {
        const next = items.nth(index + 1);
        if ((await next.count()) > 0) {
          await next.scrollIntoViewIfNeeded();
          await next.click();
          return { method: `task-list:${selector}` };
        }
      }
    }
  }

  // 策略二：点击“下一任务/下一节”按钮
  for (const selector of STUDY_SELECTORS.nextButton) {
    const button = page.locator(selector).first();
    if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
      await button.scrollIntoViewIfNeeded();
      await button.click();
      return { method: `next-button:${selector}` };
    }
  }

  return null;
}

export async function advanceTaskPoint(page, timeoutMs = 15_000) {
  const previousSignature = moduleFrameSignature(page);
  const advanced = await clickNextTaskPoint(page);
  if (advanced === null) {
    throw new Error(
      "无法定位“下一个任务点”控件，请在首次真实运行后调整 src/study-selectors.mjs 的 STUDY_SELECTORS。",
    );
  }
  const changed = await waitForModuleChange(page, previousSignature, timeoutMs);
  return { ...advanced, changed };
}

export async function processTaskPoint({ page, taskPoint, config, dryRun }) {
  const { type, frame } = taskPoint;

  if (type === "video" || type === "audio") {
    const mediaType = type;
    await waitForMediaReady(frame, mediaType);
    const media = frame.locator(mediaType).first();

    if (mediaType === "video") {
      const playButton = frame
        .locator(".vjs-big-play-button, button[title='播放视频'], .vjs-play-control.vjs-paused")
        .first();
      if ((await playButton.count()) > 0 && (await playButton.isVisible().catch(() => false))) {
        await playButton.click().catch(() => {});
      } else {
        await media.evaluate((element) => element.play?.().catch(() => {})).catch(() => {});
      }
    } else {
      await media.evaluate((element) => element.play?.().catch(() => {})).catch(() => {});
    }

    const result = await waitForMediaEnd(frame, mediaType, config.timeoutMs);
    return { type, ...result };
  }

  if (type === "quiz") {
    const result = await handleQuizWork({ frame, config, dryRun });
    return { type, ...result };
  }

  if (type === "doc" || type === "other") {
    for (const selector of STUDY_SELECTORS.markViewedButton) {
      const button = frame.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
        await button.click().catch(() => {});
        return { type, status: "viewed", detail: `已点击 ${selector}` };
      }
    }
    return { type, status: "skipped", detail: `${type} 任务点，未找到“已完成”按钮` };
  }

  return { type, status: "skipped", detail: `未知任务点类型 ${type}` };
}
