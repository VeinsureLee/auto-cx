import path from "node:path";

const DEFAULT_BASE_URL = "https://buptgrs.fanya.chaoxing.com/";
const DEFAULT_TIMEOUT_MS = 30_000;

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

  return {
    baseUrl: baseUrl.href,
    browserChannel: firstNonEmpty(env.CHAOXING_BROWSER_CHANNEL) ?? "chrome",
    browserPath: firstNonEmpty(env.CHAOXING_BROWSER_PATH),
    coursesPath,
    headless: parseBoolean(env.CHAOXING_HEADLESS, true),
    password,
    phone,
    storageStatePath,
    timeoutMs: parseTimeout(env.CHAOXING_TIMEOUT_MS),
  };
}
