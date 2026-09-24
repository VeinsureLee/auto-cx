import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright-core";

import { readConfig } from "./config.mjs";
import { openTargetLesson, selectTargetCourse } from "./course-navigation.mjs";
import { getIncompleteCourses } from "./courses.mjs";
import { readVideoState, startVideoPreview } from "./video-preview.mjs";

loadDotenv({ quiet: true });

const LOGIN_BUTTON = "#id-login";
const PHONE_INPUT = "#default_phone";
const PASSWORD_INPUT = "#default_password";
const SUBMIT_BUTTON = "#loginBtn";
const USER_MENU = "#logined";
const SPACE_ENTRY = "#user-space-index";
const LOGIN_RESPONSE_PATH = /\/entry\/login\/(?:phoneAndCxhLogin|phoneAndCxhLoginVal)$/;

function cleanServerMessage(value) {
  if (typeof value !== "string") {
    return "平台未返回可读的错误信息";
  }
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) || "平台未返回可读的错误信息";
}

async function launchBrowser(config, forceHeaded = false) {
  const launchOptions = { headless: forceHeaded ? false : config.headless };
  if (config.browserPath) {
    launchOptions.executablePath = config.browserPath;
  } else {
    launchOptions.channel = config.browserChannel;
  }
  if (config.noSandbox) {
    launchOptions.chromiumSandbox = false;
  }

  return chromium.launch(launchOptions);
}

async function waitForLoginResponse(page, timeoutMs) {
  return page.waitForResponse(
    (response) => {
      if (response.request().method() !== "POST") {
        return false;
      }

      try {
        return LOGIN_RESPONSE_PATH.test(new URL(response.url()).pathname);
      } catch {
        return false;
      }
    },
    { timeout: timeoutMs },
  );
}

async function verifyAuthenticatedHome(page, baseUrl, timeoutMs) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForFunction(() => typeof window.isLogin === "boolean", undefined, {
    timeout: timeoutMs,
  });
  return page.evaluate(() => window.isLogin === true);
}

async function enterSpace(page, timeoutMs) {
  const userMenu = page.locator(USER_MENU);
  const spaceEntry = page.locator(SPACE_ENTRY);

  await spaceEntry.waitFor({ state: "attached", timeout: timeoutMs });
  await userMenu.hover();
  await spaceEntry.waitFor({ state: "visible", timeout: timeoutMs });
  await spaceEntry.click();
  await page.waitForURL(
    (url) => url.hostname === "i.chaoxing.com" && url.pathname.startsWith("/base"),
    { timeout: timeoutMs },
  );
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
}

async function loginAndEnterSpace() {
  const config = readConfig();
  const previewVideo = process.argv.includes("--preview-video");
  const browser = await launchBrowser(config, previewVideo);

  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.timeoutMs);

    console.log("正在打开超星课程平台……");
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });

    const loginButton = page.locator(LOGIN_BUTTON);
    await loginButton.waitFor({ state: "visible" });
    await loginButton.click();

    const phoneInput = page.locator(PHONE_INPUT);
    const passwordInput = page.locator(PASSWORD_INPUT);
    await phoneInput.waitFor({ state: "visible" });
    await passwordInput.waitFor({ state: "visible" });

    await phoneInput.fill(config.phone);
    await passwordInput.fill(config.password);

    const responsePromise = waitForLoginResponse(page, config.timeoutMs);
    await page.locator(SUBMIT_BUTTON).click();

    const loginResponse = await responsePromise.catch(async (error) => {
      const captchaVisible = await page
        .locator("#captcha")
        .isVisible()
        .catch(() => false);
      if (captchaVisible) {
        throw new Error("平台要求完成验证码，本程序不会绕过验证码。请稍后重试或改用人工登录。", {
          cause: error,
        });
      }
      throw error;
    });

    let responseBody = null;
    try {
      responseBody = await loginResponse.json();
    } catch {
      // The successful login handler can navigate immediately, which may make
      // the XHR body unavailable to Playwright. The authenticated homepage is
      // the authoritative check below.
    }

    if (responseBody && responseBody.code !== 1) {
      throw new Error(`登录失败：${cleanServerMessage(responseBody?.message)}`);
    }

    await page.waitForTimeout(1_000);
    const authenticated = await verifyAuthenticatedHome(page, config.baseUrl, config.timeoutMs);
    if (!authenticated) {
      const responseDetail = responseBody
        ? `登录接口返回 code=${String(responseBody.code)}`
        : `登录响应体不可读（HTTP ${loginResponse.status()}）`;
      throw new Error(`${responseDetail}，且平台首页没有确认登录状态；未保存会话。请检查账号绑定状态。`);
    }

    console.log("登录成功，正在进入个人空间……");
    await enterSpace(page, config.timeoutMs);

    const courses = await getIncompleteCourses(page, config.timeoutMs);
    await mkdir(path.dirname(config.coursesPath), { recursive: true });
    await writeFile(config.coursesPath, `${JSON.stringify(courses, null, 2)}\n`, "utf8");

    // 先保存会话与课程列表；后面的“打开目标课节”仅用于人工核对，失败不阻断后续学习。
    await mkdir(path.dirname(config.storageStatePath), { recursive: true });
    await context.storageState({ path: config.storageStatePath });
    console.log(`已获取 ${courses.length} 门未完成课程：`);
    for (const course of courses) {
      const progress =
        course.progress.completed === null || course.progress.total === null
          ? "暂无任务点进度"
          : `${course.progress.completed}/${course.progress.total}`;
      console.log(`- ${course.name}（${progress}）`);
    }
    console.log(`课程列表已保存到 ${path.relative(process.cwd(), config.coursesPath)}。`);
    console.log(`会话已保存到 ${path.relative(process.cwd(), config.storageStatePath)}。`);

    let openedLesson = null;
    try {
      const targetCourse = selectTargetCourse(courses, config.targetCourse);
      console.log(`正在打开课程：${targetCourse.name}`);
      openedLesson = await openTargetLesson({
        context,
        course: targetCourse,
        lessonTitle: config.targetLesson,
        page,
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      console.warn(`打开目标课节失败（不影响后续自动学习）：${error.message}`);
    }

    let initialVideoState = null;
    let finalVideoState = null;
    if (previewVideo && openedLesson) {
      console.log("正在点击视频播放按钮……");
      const preview = await startVideoPreview(openedLesson.coursePage, config.timeoutMs);
      initialVideoState = preview.initialState;
      console.log(
        `视频已开始播放，将保持可见窗口 ${config.videoPreviewSeconds} 秒供检查。`,
      );
      await openedLesson.coursePage.waitForTimeout(config.videoPreviewSeconds * 1_000);
      finalVideoState = await readVideoState(preview.frame);
    }

    if (openedLesson) {
      console.log(`已打开课节：${openedLesson.lessonTitle}`);
    }
    if (initialVideoState && finalVideoState) {
      const advancedSeconds = Math.max(
        0,
        Number((finalVideoState.currentTime - initialVideoState.currentTime).toFixed(2)),
      );
      console.log(
        `视频检查结束：实际推进 ${advancedSeconds} 秒，当前 ${finalVideoState.currentTime} 秒，${finalVideoState.paused ? "已暂停" : "仍在播放"}。`,
      );
      if (finalVideoState.paused && !finalVideoState.ended) {
        console.log("平台已自动暂停视频；预览程序未尝试绕过该机制。");
      }
    }
  } finally {
    await browser.close();
  }
}

loginAndEnterSpace().catch((error) => {
  console.error(`自动登录或进入空间未完成：${error.message}`);
  process.exitCode = 1;
});
