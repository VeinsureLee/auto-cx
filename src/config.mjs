import path from "node:path";

const DEFAULT_BASE_URL = "https://buptgrs.fanya.chaoxing.com/";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TARGET_COURSE = "科研诚信";
const DEFAULT_TARGET_LESSON = "2.1 科学海洋上的高远星空";
const DEFAULT_VIDEO_PREVIEW_SECONDS = 30;
const DEFAULT_PROGRESS_CONCURRENCY = 2;

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "")?.trim();
}

export function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`布尔环境变量的值无效：${value}`);
}

function parseTimeout(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TIMEOUT_MS;
  }

  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("CHAOXING_TIMEOUT_MS 必须是 1000 到 300000 之间的整数。");
  }
  return timeoutMs;
}

function parsePreviewSeconds(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_VIDEO_PREVIEW_SECONDS;
  }

  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 3_600) {
    throw new Error("CHAOXING_VIDEO_PREVIEW_SECONDS 必须是 5 到 3600 之间的整数。");
  }
  return seconds;
}

function parseProgressConcurrency(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_PROGRESS_CONCURRENCY;
  }

  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("CHAOXING_PROGRESS_CONCURRENCY 必须是 1 到 4 之间的整数。");
  }
  return concurrency;
}

export function readConfig(env = process.env, cwd = process.cwd()) {
  const phone = firstNonEmpty(env.PhoneNumber, env.CHAOXING_PHONE);
  const password = firstNonEmpty(env.Password, env.CHAOXING_PASSWORD);

  if (!phone || !password) {
    throw new Error(
      "缺少登录凭据。请设置 PhoneNumber 和 Password（也兼容 CHAOXING_PHONE、CHAOXING_PASSWORD）。",
    );
  }

  const baseUrl = new URL(firstNonEmpty(env.CHAOXING_BASE_URL) ?? DEFAULT_BASE_URL);
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("CHAOXING_BASE_URL 必须使用 http 或 https 协议。");
  }

  const storageStatePath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_STORAGE_STATE) ?? ".auth/chaoxing-storage-state.json",
  );
  const coursesPath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_COURSES_PATH) ?? "artifacts/incomplete-courses.json",
  );
  const progressPath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_PROGRESS_PATH) ?? "artifacts/course-progress.json",
  );
  const progressMarkdownPath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_PROGRESS_MARKDOWN_PATH) ?? "artifacts/course-progress.md",
  );

  return {
    baseUrl: baseUrl.href,
    browserChannel: firstNonEmpty(env.CHAOXING_BROWSER_CHANNEL) ?? "chrome",
    browserPath: firstNonEmpty(env.CHAOXING_BROWSER_PATH),
    coursesPath,
    headless: parseBoolean(env.CHAOXING_HEADLESS, false),
    password,
    phone,
    progressConcurrency: parseProgressConcurrency(env.CHAOXING_PROGRESS_CONCURRENCY),
    progressMarkdownPath,
    progressPath,
    storageStatePath,
    targetCourse: firstNonEmpty(env.CHAOXING_TARGET_COURSE) ?? DEFAULT_TARGET_COURSE,
    targetLesson: firstNonEmpty(env.CHAOXING_TARGET_LESSON) ?? DEFAULT_TARGET_LESSON,
    timeoutMs: parseTimeout(env.CHAOXING_TIMEOUT_MS),
    videoPreviewSeconds: parsePreviewSeconds(env.CHAOXING_VIDEO_PREVIEW_SECONDS),
  };
}
