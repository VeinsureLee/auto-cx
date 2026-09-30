import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright-core";
import { parseQuestionBank } from "../assessment/question-bank.mjs";
import { readConfig } from "../config.mjs";
import { StudyMemoStore, makeCourseKey } from "../persistence/memo.mjs";
import { buildStudyReport } from "../persistence/report-builder.mjs";
import { processCourse } from "./course-worker.mjs";
import { StudyProgress } from "./progress.mjs";
import { loadSelectedCourses } from "./selection.mjs";

loadDotenv({ quiet: true });

function withSuffix(filePath, suffix) {
  const dot = filePath.lastIndexOf(".");
  if (dot <= 0) {
    return `${filePath}-${suffix}`;
  }
  return `${filePath.slice(0, dot)}-${suffix}${filePath.slice(dot)}`;
}

function lessonWorkerSuffix(lessonsQuery) {
  const joined = (lessonsQuery ?? []).map(String).join(",");
  const sanitized = joined.replace(/[^\w.\-~]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "all";
}

// 本地题库：命中且判定为 100% 正确的题目直接照抄，不再询问模型。
// 文件缺失或读不出来时退化为空题库（全部交给模型），不影响原有流程。
async function loadQuestionBank(config, log = () => {}) {
  if (!config.questionBankPath) {
    return [];
  }
  try {
    const { entries } = parseQuestionBank(await readFile(config.questionBankPath, "utf8"));
    log(`题库已加载：${entries.length} 道题（${path.relative(process.cwd(), config.questionBankPath)}）`);
    return entries;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log(`题库读取失败（${error.message}），本次作答全部交给模型`);
    }
    return [];
  }
}

export async function runStudy({
  dryRun = false,
  phase = null,
  config = null,
  coursesQuery,
  lessonsQuery = null,
  concurrency = config?.studyConcurrency,
} = {}) {
  if (![null, "video", "homework"].includes(phase)) {
    throw new Error(`不支持的学习阶段“${phase}”；目前支持 --phase video 或 --phase homework。`);
  }
  const resolvedConfig =
    config ?? readConfig(process.env, process.cwd(), { requireCredentials: false });
  const effectiveConcurrency = concurrency ?? resolvedConfig.studyConcurrency;
  if (!resolvedConfig.deepseekApiKey) {
    throw new Error("缺少 DeepSeek API Key。请设置 CHAOXING_DEEPSEEK_API_KEY 或 DEEPSEEK_API_KEY。");
  }

  // 指定了节号范围时，为每个 worker 派生独立的备忘录/报告文件，避免多进程互相覆盖。
  if (lessonsQuery?.length) {
    const suffix = lessonWorkerSuffix(lessonsQuery);
    resolvedConfig.studyMemoPath = withSuffix(resolvedConfig.studyMemoPath, suffix);
    resolvedConfig.studyMemoMarkdownPath = withSuffix(resolvedConfig.studyMemoMarkdownPath, suffix);
    resolvedConfig.studyReportPath = withSuffix(resolvedConfig.studyReportPath, suffix);
    resolvedConfig.studyReportMarkdownPath = withSuffix(resolvedConfig.studyReportMarkdownPath, suffix);
  }

  const courses = await loadSelectedCourses(resolvedConfig, coursesQuery);
  const courseIds = courses.map(makeCourseKey);
  const store = await StudyMemoStore.open({
    filePath: resolvedConfig.studyMemoPath,
    markdownPath: resolvedConfig.studyMemoMarkdownPath,
    courses,
    courseQueries: coursesQuery ?? resolvedConfig.studyCourses,
  });
  let browser = null;
  const progress = new StudyProgress({
    onSignal: () => {
      if (browser) void browser.close().catch(() => {});
    },
  });
  // 解析一次、全流程共用；挂在 config 上随现有的参数链一路传到作业作答处。
  resolvedConfig.questionBank = await loadQuestionBank(resolvedConfig, (message) => progress.log(message));
  try {
    browser = await chromium.launch({
      headless: resolvedConfig.headless,
      ...(resolvedConfig.browserPath
        ? { executablePath: resolvedConfig.browserPath }
        : { channel: resolvedConfig.browserChannel }),
      ...(resolvedConfig.noSandbox ? { chromiumSandbox: false } : {}),
    });
    const context = await browser.newContext({
      locale: "zh-CN",
      storageState: resolvedConfig.storageStatePath,
      timezoneId: "Asia/Shanghai",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(resolvedConfig.timeoutMs);
    page.setDefaultNavigationTimeout(resolvedConfig.timeoutMs);

    for (const course of courses) {
      if (progress.interrupted) throw progress.interruptionError;
      progress.log(`学习课程：${course.name}`);
      await processCourse({
        browser,
        context,
        coordinatorPage: page,
        course,
        store,
        config: resolvedConfig,
        dryRun,
        phase,
        now: Date.now,
        lessonsQuery,
        concurrency: effectiveConcurrency,
        progress,
      });
    }
    if (progress.interrupted) throw progress.interruptionError;

    return buildStudyReport({
      memo: store.state,
      courseIds,
      dryRun,
      requestedPhase: phase,
      lessonsQuery,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.studyReport = buildStudyReport({
      memo: store.state,
      courseIds,
      dryRun,
      requestedPhase: phase,
      lessonsQuery,
      fatalError: failure.message,
    });
    throw failure;
  } finally {
    progress.stop();
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
