import { readFile } from "node:fs/promises";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright-core";

import { readConfig } from "./config.mjs";
import { detectQuizSubmissionState, handleQuizWork } from "./quiz.mjs";
import {
  StudyMemoStore,
  homeworkNeedsWork,
  lessonNeedsWork,
  lessonStatusLabel,
  makeCourseKey,
  refreshCatalog,
  setLessonHomework,
  setLessonVideo,
  videoNeedsWork,
} from "./study-memo.mjs";
import {
  clickLessonInChapterFrame,
  clickTaskTab,
  discoverLessonTasks,
  isLockedLesson,
  openCourseCatalog,
  waitForTaskSurface,
} from "./task-manifest.mjs";
import { playManifestVideo } from "./video-runner.mjs";

loadDotenv({ quiet: true });

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
      matchedIds.add(makeCourseKey(match));
    }
  }

  return courses.filter((course) => matchedIds.has(makeCourseKey(course)));
}

async function loadSelectedCourses(config, coursesQuery) {
  let courses;
  try {
    courses = JSON.parse(await readFile(config.coursesPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`课程列表 ${config.coursesPath} 不是有效 JSON。`);
    }
    throw new Error(`未找到课程列表 ${config.coursesPath}，请先运行 npm run login 采集课程。`);
  }
  if (!Array.isArray(courses)) {
    throw new Error(`课程列表 ${config.coursesPath} 的顶层必须是数组。`);
  }
  const selected = filterCoursesByQuery(courses, coursesQuery ?? config.studyCourses);
  if (selected.length === 0) {
    throw new Error("没有要学习的课程（请检查课程名称关键字）。");
  }
  return selected;
}

function homeworkStatusFromResult(result) {
  if (result.status === "answered") return "submitted";
  if (result.status === "dry-run") return "dry_run";
  if (result.uncertain || (result.submissionStarted && result.status === "error")) {
    return "uncertain";
  }
  return "failed";
}

function toMemoLesson(catalogLesson) {
  return {
    knowledgeId: catalogLesson.knowledgeId,
    title: catalogLesson.label ?? catalogLesson.title,
    ordinal: catalogLesson.ordinal,
    locked: isLockedLesson(catalogLesson),
    catalogCompleted: Boolean(catalogLesson.completed),
    pendingTaskCount: catalogLesson.pendingTaskCount,
  };
}

export function pickNextLesson(catalogLessons, memoLessons, attempted, phase, dryRun = false) {
  return (
    catalogLessons.find((lesson) => {
      if (!lesson.knowledgeId) return false;
      if (attempted.has(String(lesson.knowledgeId))) return false;
      if (lesson.completed) return false;
      if (isLockedLesson(lesson)) return false;
      const memoLesson = memoLessons.find(
        (candidate) => String(candidate.knowledgeId) === String(lesson.knowledgeId),
      );
      if (!memoLesson) return false;
      return lessonNeedsWork(memoLesson, { phase, submitDryRun: !dryRun }).any;
    }) ?? null
  );
}

async function playVideoTask({ page, course, lesson, task, store, config, now }) {
  try {
    await clickTaskTab(page, task);
  } catch (error) {
    await store.mutate((state) =>
      setLessonVideo(state, course, lesson, { status: "failed", lastError: error.message ?? String(error) }, now),
    );
    return false;
  }

  const surface = await waitForTaskSurface(page, config.timeoutMs, "video", task.title);
  if (!surface) {
    await store.mutate((state) =>
      setLessonVideo(state, course, lesson, { status: "failed", lastError: `视频“${task.title}”未加载出可见内容` }, now),
    );
    return false;
  }

  try {
    await playManifestVideo({ frame: surface.frame, config });
    await store.mutate((state) =>
      setLessonVideo(state, course, lesson, { status: "done", lastError: null }, now),
    );
    return true;
  } catch (error) {
    await store.mutate((state) =>
      setLessonVideo(
        state,
        course,
        lesson,
        { status: error.blocked ? "blocked" : "failed", lastError: error.message ?? String(error) },
        now,
      ),
    );
    return false;
  }
}

function isDetachedError(error) {
  return /detached|closed|target page/i.test(error?.message ?? String(error ?? ""));
}

async function handleHomeworkTask({
  page,
  course,
  lesson,
  memoLesson,
  task,
  store,
  config,
  dryRun,
  now,
}) {
  try {
    await clickTaskTab(page, task);
  } catch (error) {
    await store.mutate((state) =>
      setLessonHomework(state, course, lesson, { status: "failed", lastError: error.message ?? String(error) }, now),
    );
    return false;
  }

  // 作业最内层 iframe 会经历一次重定向/刷新，frame 引用可能中途失效；
  // 失效时重新定位作业帧再试，最多 3 次。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const surface = await waitForTaskSurface(page, config.timeoutMs, "assessment", task.title);
    if (!surface) {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: `作业“${task.title}”未加载出可见内容` }, now),
      );
      return false;
    }

    let platformState;
    try {
      platformState = await detectQuizSubmissionState(surface.frame);
    } catch (error) {
      if (isDetachedError(error)) {
        await page.waitForTimeout(1_500);
        continue;
      }
      platformState = "unknown";
    }

    if (platformState === "submitted") {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "submitted", lastError: null }, now),
      );
      return true;
    }
    if (platformState === "captcha") {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: "平台要求验证码，请人工完成提交" }, now),
      );
      return false;
    }
    if (memoLesson.homework?.status === "uncertain" && platformState === "unknown" && !dryRun) {
      await store.mutate((state) =>
        setLessonHomework(
          state,
          course,
          lesson,
          { status: "uncertain", lastError: "上次提交结果仍无法与平台对账，未盲目重复提交" },
          now,
        ),
      );
      return false;
    }

    let result;
    try {
      result = await handleQuizWork({
        frame: surface.frame,
        page,
        config,
        dryRun,
        // 真提交时优先复用 dry-run 已保存的答案，避免重新调大模型产生不同答案。
        precomputedAnswers: dryRun ? null : (memoLesson.homework?.lastAnswers ?? null),
      });
    } catch (error) {
      if (isDetachedError(error)) {
        await page.waitForTimeout(1_500);
        continue;
      }
      result = { status: "error", detail: error.message ?? String(error) };
    }

    const status = result.reanswer ? "failed" : homeworkStatusFromResult(result);
    const patch = {
      status,
      lastError: ["submitted", "dry_run"].includes(status) ? null : result.detail,
    };
    if (result.reanswer) {
      // 答案错误较多被平台要求重答：清掉已存答案，下次重新生成而非复用。
      patch.lastAnswers = null;
    } else if (["submitted", "dry_run"].includes(status) && Array.isArray(result.answers)) {
      patch.lastAnswers = result.answers;
    }
    await store.mutate((state) => setLessonHomework(state, course, lesson, patch, now));
    return status === "submitted" || status === "dry_run";
  }

  await store.mutate((state) =>
    setLessonHomework(
      state,
      course,
      lesson,
      { status: "failed", lastError: "作业帧反复刷新，无法稳定处理，请稍后重试" },
      now,
    ),
  );
  return false;
}

async function processLesson({
  page,
  course,
  lesson,
  memoLesson,
  store,
  config,
  dryRun,
  phase,
  now,
}) {
  const { tasks, surfaceFailure } = await discoverLessonTasks({
    page,
    course,
    lesson,
    timeoutMs: config.timeoutMs,
  });
  if (surfaceFailure) {
    console.log(`      ⚠ ${surfaceFailure}`);
  }

  const videoTasks = tasks.filter((task) => task.kind === "video");
  const homeworkTasks = tasks.filter((task) => task.kind === "assessment");

  if (videoTasks.length === 0 && memoLesson.video?.status !== "none") {
    await store.mutate((state) =>
      setLessonVideo(state, course, lesson, { status: "none", lastError: null }, now),
    );
  }
  if (homeworkTasks.length === 0 && memoLesson.homework?.status !== "none") {
    await store.mutate((state) =>
      setLessonHomework(state, course, lesson, { status: "none", lastError: null }, now),
    );
  }

  if (phase !== "homework" && videoNeedsWork(memoLesson.video)) {
    for (const task of videoTasks) {
      const ok = await playVideoTask({ page, course, lesson, task, store, config, now });
      if (!ok) break;
    }
  }

  if (phase !== "video" && homeworkNeedsWork(memoLesson.homework, { submitDryRun: !dryRun })) {
    for (const task of homeworkTasks) {
      const ok = await handleHomeworkTask({
        page,
        course,
        lesson,
        memoLesson,
        task,
        store,
        config,
        dryRun,
        now,
      });
      if (!ok) break;
    }
  }
}

async function processCourse({ page, course, store, config, dryRun, phase, now }) {
  const attempted = new Set();

  for (let round = 0; round < 500; round += 1) {
    // 两个课节之间稍作停顿，降低连续跳转触发平台限流的概率。
    if (round > 0) {
      await page.waitForTimeout(2_000);
    }
    const { chapterFrame, lessons: catalogLessons } = await openCourseCatalog(
      page,
      course,
      config.timeoutMs,
    );
    const courseRecord = await store.mutate((state) =>
      refreshCatalog(state, course, catalogLessons.map(toMemoLesson), now),
    );

    const target = pickNextLesson(catalogLessons, courseRecord.lessons, attempted, phase, dryRun);
    if (!target) {
      break;
    }
    attempted.add(String(target.knowledgeId));

    console.log(`  - 学习课节：${target.label ?? target.title}`);
    const cardsFrame = await clickLessonInChapterFrame({
      chapterFrame,
      page,
      lesson: target,
      timeoutMs: config.timeoutMs,
    });
    if (!cardsFrame) {
      await store.mutate((state) => {
        setLessonVideo(state, course, target, { status: "failed", lastError: "课节打开后未找到内容帧" }, now);
        setLessonHomework(state, course, target, { status: "failed", lastError: "课节打开后未找到内容帧" }, now);
      });
      continue;
    }

    const memoLesson = courseRecord.lessons.find(
      (candidate) => String(candidate.knowledgeId) === String(target.knowledgeId),
    );
    await processLesson({
      page,
      course,
      lesson: target,
      memoLesson,
      store,
      config,
      dryRun,
      phase,
      now,
    });
  }
}

function lessonDetail(lesson) {
  const parts = [];
  if (lesson.catalogCompleted) parts.push("目录已完成");
  if (lesson.locked) parts.push("被闯关锁定");
  if (lesson.homework?.lastAnswers?.length) {
    parts.push(`已存答案 ${lesson.homework.lastAnswers.length} 题`);
  }
  if (lesson.video?.lastError) parts.push(`视频：${lesson.video.lastError}`);
  if (lesson.homework?.lastError) parts.push(`作业：${lesson.homework.lastError}`);
  return parts.join("；") || null;
}

export function buildStudyReport({
  memo,
  courseIds,
  dryRun,
  requestedPhase = null,
  fatalError = null,
  generatedAt = new Date().toISOString(),
}) {
  const selected = new Set(courseIds.map(String));
  return {
    schemaVersion: 1,
    generatedAt,
    dryRun,
    requestedPhase,
    fatalError,
    courses: memo.courses
      .filter(
        (course) =>
          selected.has(makeCourseKey(course)) || selected.has(String(course.courseId)),
      )
      .map((course) => ({
        courseId: course.courseId,
        clazzId: course.clazzId,
        name: course.name,
        lessons: (course.lessons ?? []).map((lesson) => ({
          title: lesson.title,
          knowledgeId: lesson.knowledgeId,
          ordinal: lesson.ordinal,
          status: lessonStatusLabel(lesson),
          detail: lessonDetail(lesson),
          video: { status: lesson.video?.status ?? "—", lastError: lesson.video?.lastError ?? null },
          homework: {
            status: lesson.homework?.status ?? "—",
            lastError: lesson.homework?.lastError ?? null,
            lastAnswers: lesson.homework?.lastAnswers ?? null,
          },
        })),
      })),
  };
}

export async function runStudy({ dryRun = false, phase = null, config, coursesQuery } = {}) {
  if (![null, "video", "homework"].includes(phase)) {
    throw new Error(`不支持的学习阶段“${phase}”；目前支持 --phase video 或 --phase homework。`);
  }
  const resolvedConfig =
    config ?? readConfig(process.env, process.cwd(), { requireCredentials: false });
  if (!resolvedConfig.deepseekApiKey) {
    throw new Error("缺少 DeepSeek API Key。请设置 CHAOXING_DEEPSEEK_API_KEY 或 DEEPSEEK_API_KEY。");
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
      console.log(`学习课程：${course.name}`);
      await processCourse({
        page,
        course,
        store,
        config: resolvedConfig,
        dryRun,
        phase,
        now: Date.now,
      });
    }

    return buildStudyReport({
      memo: store.state,
      courseIds,
      dryRun,
      requestedPhase: phase,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.studyReport = buildStudyReport({
      memo: store.state,
      courseIds,
      dryRun,
      requestedPhase: phase,
      fatalError: failure.message,
    });
    throw failure;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
