import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseBoolean, readConfig } from "../src/config.mjs";

test("readConfig reads the documented credential names without exposing them", () => {
  const config = readConfig(
    {
      PhoneNumber: " 13800138000 ",
      Password: " example-password ",
    },
    "C:\\workspace",
  );

  assert.equal(config.phone, "13800138000");
  assert.equal(config.password, "example-password");
  assert.equal(config.baseUrl, "https://buptgrs.fanya.chaoxing.com/");
  assert.equal(config.headless, false);
  assert.equal(config.targetCourse, "科研诚信");
  assert.equal(config.targetLesson, "2.1 科学海洋上的高远星空");
  assert.equal(config.videoPreviewSeconds, 30);
  assert.equal(config.progressConcurrency, 2);
  assert.equal(config.progressPath, path.resolve("C:\\workspace", "artifacts/course-progress.json"));
  assert.equal(
    config.progressMarkdownPath,
    path.resolve("C:\\workspace", "artifacts/course-progress.md"),
  );
  assert.equal(
    config.coursesPath,
    path.resolve("C:\\workspace", "artifacts/incomplete-courses.json"),
  );
  assert.equal(
    config.storageStatePath,
    path.resolve("C:\\workspace", ".auth/chaoxing-storage-state.json"),
  );
});

test("readConfig accepts CHAOXING_* aliases and optional settings", () => {
  const config = readConfig({
    CHAOXING_PHONE: "13800138000",
    CHAOXING_PASSWORD: "secret",
    CHAOXING_HEADLESS: "false",
    CHAOXING_TIMEOUT_MS: "45000",
    CHAOXING_BROWSER_CHANNEL: "msedge",
    CHAOXING_COURSES_PATH: "output/courses.json",
    CHAOXING_TARGET_COURSE: "示例课程",
    CHAOXING_TARGET_LESSON: "3.2 示例课节",
    CHAOXING_VIDEO_PREVIEW_SECONDS: "45",
    CHAOXING_PROGRESS_CONCURRENCY: "1",
    CHAOXING_PROGRESS_PATH: "output/progress.json",
    CHAOXING_PROGRESS_MARKDOWN_PATH: "output/progress.md",
  });

  assert.equal(config.headless, false);
  assert.equal(config.timeoutMs, 45_000);
  assert.equal(config.browserChannel, "msedge");
  assert.equal(config.coursesPath, path.resolve("output/courses.json"));
  assert.equal(config.targetCourse, "示例课程");
  assert.equal(config.targetLesson, "3.2 示例课节");
  assert.equal(config.videoPreviewSeconds, 45);
  assert.equal(config.progressConcurrency, 1);
  assert.equal(config.progressPath, path.resolve("output/progress.json"));
  assert.equal(config.progressMarkdownPath, path.resolve("output/progress.md"));
});

test("readConfig reads the auto-study settings with defaults", () => {
  const config = readConfig(
    { PhoneNumber: "13800138000", Password: "secret" },
    "C:\\workspace",
  );

  assert.equal(config.deepseekApiKey, undefined);
  assert.equal(config.llmModel, "deepseek-chat");
  assert.equal(config.llmBaseUrl, "https://api.deepseek.com/");
  assert.equal(config.studyReportPath, path.resolve("C:\\workspace", "artifacts/study-report.json"));
  assert.equal(
    config.studyReportMarkdownPath,
    path.resolve("C:\\workspace", "artifacts/study-report.md"),
  );
  assert.equal(
    config.studyMemoPath,
    path.resolve("C:\\workspace", "artifacts/study-memo.json"),
  );
  assert.equal(
    config.studyMemoMarkdownPath,
    path.resolve("C:\\workspace", "artifacts/study-memo.md"),
  );
  assert.equal(config.videoTargetPercent, 95);
  assert.equal(config.videoRetryLimit, 3);
});

test("readConfig supports the DeepSeek key aliases and custom study paths", () => {
  const config = readConfig(
    {
      CHAOXING_PHONE: "13800138000",
      CHAOXING_PASSWORD: "secret",
      CHAOXING_DEEPSEEK_API_KEY: "sk-test",
      CHAOXING_LLM_MODEL: "deepseek-reasoner",
      CHAOXING_LLM_BASE_URL: "https://api.deepseek.com/v1",
      CHAOXING_STUDY_REPORT_PATH: "output/study.json",
      CHAOXING_STUDY_REPORT_MARKDOWN_PATH: "output/study.md",
      CHAOXING_STUDY_MEMO_PATH: "output/study-memo.json",
      CHAOXING_STUDY_MEMO_MARKDOWN_PATH: "output/study-memo.md",
      CHAOXING_VIDEO_TARGET_PERCENT: "90",
      CHAOXING_VIDEO_RETRY_LIMIT: "4",
    },
    "C:\\workspace",
  );

  assert.equal(config.deepseekApiKey, "sk-test");
  assert.equal(config.llmModel, "deepseek-reasoner");
  assert.equal(config.llmBaseUrl, "https://api.deepseek.com/v1");
  assert.equal(config.studyReportPath, path.resolve("C:\\workspace", "output/study.json"));
  assert.equal(config.studyReportMarkdownPath, path.resolve("C:\\workspace", "output/study.md"));
  assert.equal(config.studyMemoPath, path.resolve("C:\\workspace", "output/study-memo.json"));
  assert.equal(config.studyMemoMarkdownPath, path.resolve("C:\\workspace", "output/study-memo.md"));
  assert.equal(config.videoTargetPercent, 90);
  assert.equal(config.videoRetryLimit, 4);
});

test("readConfig falls back to the bare DEEPSEEK_API_KEY name", () => {
  const config = readConfig({
    DEEPSEEK_API_KEY: "sk-bare",
    CHAOXING_PHONE: "13800138000",
    CHAOXING_PASSWORD: "secret",
  });

  assert.equal(config.deepseekApiKey, "sk-bare");
});

test("readConfig validates the LLM base URL protocol", () => {
  assert.throws(
    () =>
      readConfig({
        CHAOXING_LLM_BASE_URL: "ftp://api.deepseek.com",
        CHAOXING_PHONE: "13800138000",
        CHAOXING_PASSWORD: "secret",
      }),
    /http 或 https/,
  );
});

test("readConfig with requireCredentials false skips the credential check", () => {
  const config = readConfig({}, "C:\\workspace", { requireCredentials: false });
  assert.equal(config.phone, undefined);
  assert.equal(config.password, undefined);
  assert.ok(config.storageStatePath);
});

test("readConfig rejects missing credentials", () => {
  assert.throws(() => readConfig({}), /缺少登录凭据/);
});

test("readConfig validates the video preview duration", () => {
  assert.throws(
    () =>
      readConfig({
        PhoneNumber: "13800138000",
        Password: "secret",
        CHAOXING_VIDEO_PREVIEW_SECONDS: "4",
      }),
    /5 到 3600/,
  );
});

test("readConfig validates progress concurrency", () => {
  assert.throws(
    () =>
      readConfig({
        PhoneNumber: "13800138000",
        Password: "secret",
        CHAOXING_PROGRESS_CONCURRENCY: "5",
      }),
    /1 到 4/,
  );
});

test("readConfig reads the no-sandbox flag for root environments", () => {
  assert.equal(
    readConfig({ PhoneNumber: "13800138000", Password: "secret" }, "C:\\workspace").noSandbox,
    false,
  );
  assert.equal(
    readConfig(
      { PhoneNumber: "13800138000", Password: "secret", CHAOXING_NO_SANDBOX: "true" },
      "C:\\workspace",
    ).noSandbox,
    true,
  );
});

test("parseBoolean validates input", () => {
  assert.equal(parseBoolean("yes", false), true);
  assert.equal(parseBoolean("0", true), false);
  assert.throws(() => parseBoolean("sometimes", true), /布尔环境变量/);
});

test("readConfig validates the video target and retry limit", () => {
  assert.throws(
    () =>
      readConfig({
        PhoneNumber: "13800138000",
        Password: "secret",
        CHAOXING_VIDEO_TARGET_PERCENT: "101",
      }),
    /VIDEO_TARGET_PERCENT/,
  );
  assert.throws(
    () =>
      readConfig({
        PhoneNumber: "13800138000",
        Password: "secret",
        CHAOXING_VIDEO_RETRY_LIMIT: "0",
      }),
    /VIDEO_RETRY_LIMIT/,
  );
});

test("readConfig defaults study concurrency to one", () => {
  const config = readConfig({}, "C:\\workspace", { requireCredentials: false });
  assert.equal(config.studyConcurrency, 1);
});

test("readConfig accepts study concurrency up to three", () => {
  const config = readConfig(
    { CHAOXING_STUDY_CONCURRENCY: "3" },
    "C:\\workspace",
    { requireCredentials: false },
  );
  assert.equal(config.studyConcurrency, 3);
});

test("readConfig lets an explicit CLI concurrency replace malformed study env while validating other env", () => {
  const config = readConfig({ CHAOXING_STUDY_CONCURRENCY: "not-an-integer" }, "C:\\workspace", {
    requireCredentials: false,
    studyConcurrencyOverride: 2,
  });
  assert.equal(config.studyConcurrency, 2);
  assert.throws(
    () => readConfig({
      CHAOXING_STUDY_CONCURRENCY: "not-an-integer",
      CHAOXING_TIMEOUT_MS: "bad",
    }, "C:\\workspace", {
      requireCredentials: false,
      studyConcurrencyOverride: 2,
    }),
    /CHAOXING_TIMEOUT_MS/,
  );
});

test("readConfig rejects study concurrency outside one through three", () => {
  assert.throws(
    () => readConfig({ CHAOXING_STUDY_CONCURRENCY: "0" }, process.cwd(), { requireCredentials: false }),
    /CHAOXING_STUDY_CONCURRENCY 必须是 1 到 3/,
  );
  assert.throws(
    () => readConfig({ CHAOXING_STUDY_CONCURRENCY: "4" }, process.cwd(), { requireCredentials: false }),
    /CHAOXING_STUDY_CONCURRENCY 必须是 1 到 3/,
  );
});

test("readConfig reads the video speed with a 2x default", () => {
  assert.equal(
    readConfig({ PhoneNumber: "13800138000", Password: "secret" }, "C:\\workspace").videoSpeed,
    2,
  );
  assert.equal(
    readConfig(
      { PhoneNumber: "13800138000", Password: "secret", CHAOXING_VIDEO_SPEED: "1.5" },
      "C:\\workspace",
    ).videoSpeed,
    1.5,
  );
  assert.throws(
    () =>
      readConfig(
        { PhoneNumber: "13800138000", Password: "secret", CHAOXING_VIDEO_SPEED: "5" },
        "C:\\workspace",
      ),
    /VIDEO_SPEED/,
  );
});
