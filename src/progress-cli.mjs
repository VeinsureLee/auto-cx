import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright-core";

import { readConfig } from "./config.mjs";
import {
  collectProgressWithConcurrency,
  renderProgressMarkdown,
} from "./course-progress.mjs";

loadDotenv({ quiet: true });

async function launchBrowser(config) {
  const options = { headless: config.headless };
  if (config.browserPath) {
    options.executablePath = config.browserPath;
  } else {
    options.channel = config.browserChannel;
  }
  return chromium.launch(options);
}

async function collectProgress() {
  const config = readConfig();
  const courses = JSON.parse(await readFile(config.coursesPath, "utf8"));
  const browser = await launchBrowser(config);

  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      storageState: config.storageStatePath,
      timezoneId: "Asia/Shanghai",
    });

    console.log(
      `正在以并发数 ${config.progressConcurrency} 读取 ${courses.length} 门课程的章节进度……`,
    );
    const courseProgress = await collectProgressWithConcurrency(
      context,
      courses,
      config.progressConcurrency,
      config.timeoutMs,
    );
    const report = {
      concurrency: config.progressConcurrency,
      courses: courseProgress,
      generatedAt: new Date().toISOString(),
    };

    await mkdir(path.dirname(config.progressPath), { recursive: true });
    await mkdir(path.dirname(config.progressMarkdownPath), { recursive: true });
    await writeFile(config.progressPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(config.progressMarkdownPath, renderProgressMarkdown(report), "utf8");

    for (const course of courseProgress) {
      console.log(
        `- ${course.name}：${course.summary.completed}/${course.summary.total} 已完成，${course.summary.notCompleted} 未完成`,
      );
    }
    console.log(`JSON 进度已保存到 ${path.relative(process.cwd(), config.progressPath)}。`);
    console.log(
      `Markdown 进度表已保存到 ${path.relative(process.cwd(), config.progressMarkdownPath)}。`,
    );
  } finally {
    await browser.close();
  }
}

collectProgress().catch((error) => {
  console.error(`课程进度读取失败：${error.message}`);
  process.exitCode = 1;
});
