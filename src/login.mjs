import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright-core";

import { readConfig } from "./config.mjs";

loadDotenv({ quiet: true });

const LOGIN_BUTTON = "#id-login";
const PHONE_INPUT = "#default_phone";
const PASSWORD_INPUT = "#default_password";
const SUBMIT_BUTTON = "#loginBtn";
const LOGIN_RESPONSE_PATH = /\/entry\/login\/(?:phoneAndCxhLogin|phoneAndCxhLoginVal)$/;

function cleanServerMessage(value) {
  if (typeof value !== "string") {
    return "平台未返回可读的错误信息";
  }
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) || "平台未返回可读的错误信息";
}

async function launchBrowser(config) {
  const launchOptions = { headless: config.headless };
  if (config.browserPath) {
    launchOptions.executablePath = config.browserPath;
  } else {
    launchOptions.channel = config.browserChannel;
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

async function login() {
  const config = readConfig();
  const browser = await launchBrowser(config);

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

    await mkdir(path.dirname(config.storageStatePath), { recursive: true });
    await context.storageState({ path: config.storageStatePath });
    console.log(`登录成功，会话已保存到 ${path.relative(process.cwd(), config.storageStatePath)}。`);
  } finally {
    await browser.close();
  }
}

login().catch((error) => {
  console.error(`自动登录未完成：${error.message}`);
  process.exitCode = 1;
});
