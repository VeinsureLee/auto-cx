import { readFile } from "node:fs/promises";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright-core";

import { readConfig } from "./config.mjs";
import { waitForChapterFrame, listLessons } from "./course-progress.mjs";
import { STUDY_SELECTORS } from "./study-selectors.mjs";
import { advanceTaskPoint, detectTaskPointFrame, processTaskPoint } from "./task-point.mjs";

const MAX_TASK_POINTS_PER_LESSON = 60;

loadDotenv({ quiet: true });

async function waitForCardsFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let pathname;
      try {
        pathname = new URL(frame.url()).pathname;
      } catch {
        continue;
      }
      if (pathname.includes("/mooc-ans/knowledge/cards")) {
        return frame;
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

function activeKnowledgeId(page) {
  try {
    const url = new URL(page.url());
    return url.searchParams.get("knowledgeid") || url.searchParams.get("chapterId") || null;
  } catch {
    return null;
  }
}

async function openLesson({ page, course, lesson, timeoutMs }) {
  await page.goto(course.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const chapterNav = page.locator(STUDY_SELECTORS.chapterNav);
  await chapterNav.waitFor({ state: "visible", timeout: timeoutMs });
  await chapterNav.click();

  const chapterFrame = await waitForChapterFrame(page, timeoutMs);
  const lessonItems = chapterFrame.locator(STUDY_SELECTORS.lessonItem);
  const count = await lessonItems.count();
  for (let index = 0; index < count; index += 1) {
    const item = lessonItems.nth(index);
    const itemId = await item.getAttribute("id").catch(() => "");
    const knowledgeId = itemId?.startsWith("cur") ? itemId.slice(3) : null;
    if (knowledgeId === lesson.knowledgeId) {
      const link = item.locator(STUDY_SELECTORS.lessonLink).first();
      await link.waitFor({ state: "visible", timeout: timeoutMs });
      await link.click();
      await page.waitForURL(
        (url) =>
          url.hostname === "mooc1.chaoxing.com" &&
          url.pathname.includes("/mycourse/studentstudy"),
        { timeout: timeoutMs },
      );
      const cardsFrame = await waitForCardsFrame(page, timeoutMs);
      return cardsFrame;
    }
  }
  return null;
}

function isLockedLesson(lesson) {
  return typeof lesson.progressText === "string" && lesson.progressText.includes("需完成之前闯关任务点");
}

async function processLesson({ page, course, lesson, config, dryRun }) {
  const taskPoints = [];
  const cardsFrame = await openLesson({ page, course, lesson, timeoutMs: config.timeoutMs });

  if (!cardsFrame) {
    if (isLockedLesson(lesson)) {
      return { status: "skipped", detail: `课节被“闯关”锁定（${lesson.progressText}），未处理`, taskPoints };
    }
    return { status: "error", detail: "课节打开后未找到内容帧，请人工检查", taskPoints };
  }

  const initialKnowledgeId = lesson.knowledgeId;
  let previousFrameUrl = null;

  for (let step = 0; step < MAX_TASK_POINTS_PER_LESSON; step += 1) {
    let taskPoint = await detectTaskPointFrame(page);
    if (!taskPoint) {
      await page.waitForTimeout(800);
      taskPoint = await detectTaskPointFrame(page);
      if (!taskPoint) {
        return { status: "completed", detail: "未发现更多任务点", taskPoints };
      }
    }

    const frameUrl = taskPoint.frame.url();
    if (previousFrameUrl === frameUrl) {
      return { status: "error", detail: "任务点推进卡住（同一模块帧未变化），请人工检查", taskPoints };
    }
    previousFrameUrl = frameUrl;

    const processed = await processTaskPoint({ page, taskPoint, config, dryRun }).catch(
      (error) => ({ type: taskPoint.type, status: "error", detail: error.message ?? String(error) }),
    );
    taskPoints.push({ ...processed, frameUrl });
    if (processed.status === "error") {
      return { status: "error", detail: processed.detail, taskPoints };
    }

    try {
      await advanceTaskPoint(page, config.timeoutMs);
    } catch (error) {
      const currentKnowledgeId = activeKnowledgeId(page);
      if (initialKnowledgeId && currentKnowledgeId && currentKnowledgeId !== initialKnowledgeId) {
        return { status: "completed", detail: "已推进到下一课节", taskPoints };
      }
      // 找不到“下一任务点”控件，且当前已无模块帧 → 课节实际上已完成
      await page.waitForTimeout(1_000);
      const stillActive = await detectTaskPointFrame(page);
      if (!stillActive) {
        return { status: "completed", detail: "课节任务点已全部完成，未发现下一任务点控件", taskPoints };
      }
      return { status: "error", detail: error.message, taskPoints };
    }

    const knowledgeIdAfterAdvance = activeKnowledgeId(page);
    if (
      initialKnowledgeId &&
      knowledgeIdAfterAdvance &&
      knowledgeIdAfterAdvance !== initialKnowledgeId
    ) {
      return { status: "completed", detail: "已推进到下一课节", taskPoints };
    }
  }

  return { status: "error", detail: "任务点数量超出上限，疑似循环", taskPoints };
}

async function loadCourseLessons(page, course, timeoutMs) {
  await page.goto(course.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const chapterNav = page.locator(STUDY_SELECTORS.chapterNav);
  await chapterNav.waitFor({ state: "visible", timeout: timeoutMs });
  await chapterNav.click();
  const chapterFrame = await waitForChapterFrame(page, timeoutMs);
  return listLessons(chapterFrame, timeoutMs);
}

export async function studyCourse({ context, course, config, dryRun }) {
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);
  page.setDefaultNavigationTimeout(config.timeoutMs);

  const results = [];
  try {
    let lessons = await loadCourseLessons(page, course, config.timeoutMs);
    let index = 0;

    while (index < lessons.length) {
      const lesson = lessons[index];

      if (lesson.completed || !lesson.knowledgeId) {
        results.push({
          title: lesson.title,
          knowledgeId: lesson.knowledgeId,
          status: "skipped",
          detail: lesson.completed ? "已是完成状态" : "非课节节点（目录标题）",
          taskPoints: [],
        });
        index += 1;
        continue;
      }

      if (isLockedLesson(lesson)) {
        results.push({
          title: lesson.title,
          knowledgeId: lesson.knowledgeId,
          status: "skipped",
          detail: `被“闯关”锁定（${lesson.progressText}）`,
          taskPoints: [],
        });
        index += 1;
        continue;
      }

      console.log(`  - 学习课节：${lesson.title}`);
      const outcome = await processLesson({ page, course, lesson, config, dryRun }).catch(
        (error) => ({
          status: "error",
          detail: error.message ?? String(error),
          taskPoints: [],
        }),
      );
      results.push({
        title: lesson.title,
        knowledgeId: lesson.knowledgeId,
        status: outcome.status,
        detail: outcome.detail,
        taskPoints: outcome.taskPoints,
      });

      if (outcome.status === "completed" || outcome.status === "error") {
        lessons = await loadCourseLessons(page, course, config.timeoutMs);
        index = 0;
      } else {
        index += 1;
      }
    }

    return { courseId: course.courseId, name: course.name, lessons: results };
  } finally {
    await page.close();
  }
}

export function filterCoursesByQuery(courses, queries) {
  if (!queries?.length) {
    return courses;
  }
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const matchedIds = new Set();

  const splitQueries = queries.flatMap((query) =>
    String(query ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  );

  for (const query of splitQueries) {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) {
      continue;
    }
    const matches = courses.filter((course) => normalize(course.name).includes(normalizedQuery));
    if (matches.length === 0) {
      throw new Error(`未找到名称包含“${query}”的课程。`);
    }
    for (const match of matches) {
      matchedIds.add(match.courseId);
    }
  }

  return courses.filter((course) => matchedIds.has(course.courseId));
}

export async function studyAllCourses({ context, courses, config, dryRun }) {
  const reports = [];
  for (const course of courses) {
    console.log(`正在学习课程：${course.name}`);
    reports.push(await studyCourse({ context, course, config, dryRun }));
  }
  return reports;
}

export async function runStudy({ dryRun = false, config, coursesQuery } = {}) {
  const resolvedConfig =
    config ?? readConfig(process.env, process.cwd(), { requireCredentials: false });
  if (!resolvedConfig.deepseekApiKey) {
    throw new Error("缺少 DeepSeek API Key。请设置 CHAOXING_DEEPSEEK_API_KEY 或 DEEPSEEK_API_KEY。");
  }

  let courses;
  try {
    courses = JSON.parse(await readFile(resolvedConfig.coursesPath, "utf8"));
  } catch {
    throw new Error(
      `未找到课程列表 ${resolvedConfig.coursesPath}，请先运行 npm run login 采集课程。`,
    );
  }
  courses = filterCoursesByQuery(courses, coursesQuery ?? resolvedConfig.studyCourses);
  if (courses.length === 0) {
    throw new Error("没有要学习的课程（请检查课程名称关键字）。");
  }

  const browser = await chromium.launch({
    headless: resolvedConfig.headless,
    ...(resolvedConfig.browserPath
      ? { executablePath: resolvedConfig.browserPath }
      : { channel: resolvedConfig.browserChannel }),
  });

  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      storageState: resolvedConfig.storageStatePath,
      timezoneId: "Asia/Shanghai",
    });
    const generatedAt = new Date().toISOString();
    const coursesOutcome = await studyAllCourses({
      context,
      courses,
      config: resolvedConfig,
      dryRun,
    });
    return { courses: coursesOutcome, dryRun, generatedAt };
  } finally {
    await browser.close();
  }
}