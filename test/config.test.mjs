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
  assert.equal(config.headless, true);
  assert.equal(config.targetCourse, "科研诚信");
  assert.equal(config.targetLesson, "2.1 科学海洋上的高远星空");
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
  });

  assert.equal(config.headless, false);
  assert.equal(config.timeoutMs, 45_000);
  assert.equal(config.browserChannel, "msedge");
  assert.equal(config.coursesPath, path.resolve("output/courses.json"));
  assert.equal(config.targetCourse, "示例课程");
  assert.equal(config.targetLesson, "3.2 示例课节");
});

test("readConfig rejects missing credentials", () => {
  assert.throws(() => readConfig({}), /缺少登录凭据/);
});

test("parseBoolean validates input", () => {
  assert.equal(parseBoolean("yes", false), true);
  assert.equal(parseBoolean("0", true), false);
  assert.throws(() => parseBoolean("sometimes", true), /布尔环境变量/);
});
