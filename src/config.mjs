import path from "node:path";

const DEFAULT_BASE_URL = "https://buptgrs.fanya.chaoxing.com/";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TARGET_COURSE = "科研诚信";
const DEFAULT_TARGET_LESSON = "2.1 科学海洋上的高远星空";
const DEFAULT_VIDEO_PREVIEW_SECONDS = 30;
const DEFAULT_PROGRESS_CONCURRENCY = 2;
const DEFAULT_LLM_MODEL = "deepseek-chat";
const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";
const DEFAULT_VIDEO_TARGET_PERCENT = 95;
const DEFAULT_VIDEO_RETRY_LIMIT = 3;

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

function parseIntegerInRange(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed;
}

function parseList(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseHttpUrl(value, fallback, label) {
  const url = new URL(firstNonEmpty(value) ?? fallback);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} 必须使用 http 或 https 协议。`);
  }
  return url.href;
}

export function readConfig(env = process.env, cwd = process.cwd(), options = {}) {
  const requireCredentials = options.requireCredentials !== false;
  const phone = firstNonEmpty(env.PhoneNumber, env.CHAOXING_PHONE);
  const password = firstNonEmpty(env.Password, env.CHAOXING_PASSWORD);

  if (requireCredentials && (!phone || !password)) {
    throw new Error(
      "缺少登录凭据。请设置 PhoneNumber 和 Password（也兼容 CHAOXING_PHONE、CHAOXING_PASSWORD）。",
    );
  }

  const baseUrl = parseHttpUrl(env.CHAOXING_BASE_URL, DEFAULT_BASE_URL, "CHAOXING_BASE_URL");
  const llmBaseUrl = parseHttpUrl(
    env.CHAOXING_LLM_BASE_URL,
    DEFAULT_LLM_BASE_URL,
    "CHAOXING_LLM_BASE_URL",
  );

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
  const studyReportPath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_STUDY_REPORT_PATH) ?? "artifacts/study-report.json",
  );
  const studyReportMarkdownPath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_STUDY_REPORT_MARKDOWN_PATH) ?? "artifacts/study-report.md",
  );
  const studyMemoPath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_STUDY_MEMO_PATH) ?? "artifacts/study-memo.json",
  );
  const studyMemoMarkdownPath = path.resolve(
    cwd,
    firstNonEmpty(env.CHAOXING_STUDY_MEMO_MARKDOWN_PATH) ?? "artifacts/study-memo.md",
  );

  return {
    baseUrl,
    browserChannel: firstNonEmpty(env.CHAOXING_BROWSER_CHANNEL) ?? "chrome",
    browserPath: firstNonEmpty(env.CHAOXING_BROWSER_PATH),
    coursesPath,
    deepseekApiKey: firstNonEmpty(env.CHAOXING_DEEPSEEK_API_KEY, env.DEEPSEEK_API_KEY),
    headless: parseBoolean(env.CHAOXING_HEADLESS, false),
    llmBaseUrl,
    noSandbox: parseBoolean(env.CHAOXING_NO_SANDBOX, false),
    llmModel: firstNonEmpty(env.CHAOXING_LLM_MODEL) ?? DEFAULT_LLM_MODEL,
    password,
    phone,
    progressConcurrency: parseProgressConcurrency(env.CHAOXING_PROGRESS_CONCURRENCY),
    progressMarkdownPath,
    progressPath,
    storageStatePath,
    studyCourses: parseList(env.CHAOXING_STUDY_COURSES),
    studyMemoMarkdownPath,
    studyMemoPath,
    studyReportMarkdownPath,
    studyReportPath,
    targetCourse: firstNonEmpty(env.CHAOXING_TARGET_COURSE) ?? DEFAULT_TARGET_COURSE,
    targetLesson: firstNonEmpty(env.CHAOXING_TARGET_LESSON) ?? DEFAULT_TARGET_LESSON,
    timeoutMs: parseTimeout(env.CHAOXING_TIMEOUT_MS),
    videoPreviewSeconds: parsePreviewSeconds(env.CHAOXING_VIDEO_PREVIEW_SECONDS),
    videoRetryLimit: parseIntegerInRange(
      env.CHAOXING_VIDEO_RETRY_LIMIT,
      DEFAULT_VIDEO_RETRY_LIMIT,
      1,
      10,
      "CHAOXING_VIDEO_RETRY_LIMIT",
    ),
    videoTargetPercent: parseIntegerInRange(
      env.CHAOXING_VIDEO_TARGET_PERCENT,
      DEFAULT_VIDEO_TARGET_PERCENT,
      1,
      100,
      "CHAOXING_VIDEO_TARGET_PERCENT",
    ),
  };
}
