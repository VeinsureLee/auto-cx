const VIDEO_FRAME_PATH = "/ananas/modules/video/index.html";
const PLAY_BUTTON_SELECTORS = [
  ".vjs-big-play-button",
  'button[title="播放视频"]',
  ".vjs-play-control.vjs-paused",
];

async function findVideoFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let frameUrl;
      try {
        frameUrl = new URL(frame.url());
      } catch {
        continue;
      }
      if (frameUrl.pathname === VIDEO_FRAME_PATH && (await frame.locator("video").count()) > 0) {
        return frame;
      }
    }
    await page.waitForTimeout(200);
  }

  throw new Error("目标课节中未找到视频播放器。");
}

async function findVisiblePlayButton(frame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of PLAY_BUTTON_SELECTORS) {
      const button = frame.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isVisible())) {
        return button;
      }
    }
    await frame.waitForTimeout(200);
  }

  throw new Error("视频播放器已加载，但未找到可见的播放按钮。");
}

export async function readVideoState(frame) {
  return frame.locator("video").first().evaluate((video) => ({
    currentTime: Number(video.currentTime.toFixed(2)),
    duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
    ended: video.ended,
    paused: video.paused,
    readyState: video.readyState,
  }));
}

export async function startVideoPreview(page, timeoutMs) {
  await page.bringToFront();
  const frame = await findVideoFrame(page, timeoutMs);
  const video = frame.locator("video").first();
  await video.waitFor({ state: "visible", timeout: timeoutMs });

  const playButton = await findVisiblePlayButton(frame, timeoutMs);
  await playButton.click();
  await frame.waitForFunction(
    () => {
      const currentVideo = document.querySelector("video");
      return currentVideo && !currentVideo.paused && !currentVideo.ended;
    },
    undefined,
    { timeout: timeoutMs },
  );

  return {
    frame,
    initialState: await readVideoState(frame),
  };
}
