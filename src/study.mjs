import { readFile } from "node:fs/promises";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright-core";

import { readConfig } from "./config.mjs";
import { detectQuizSubmissionState, handleQuizWork } from "./quiz.mjs";
import {
  StudyMemoStore,
  homeworkNeedsWork,
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
import {
  filterLessonsByQuery,
  runDynamicWorkerPool,
  selectEligibleLessons,
} from "./study-scheduler.mjs";
import { StudyProgress } from "./study-progress.mjs";
import { playManifestVideo } from "./video-runner.mjs";

loadDotenv({ quiet: true });

export { filterLessonsByQuery } from "./study-scheduler.mjs";

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
    section: catalogLesson.section ?? null,
    ordinal: catalogLesson.ordinal,
    locked: isLockedLesson(catalogLesson),
    catalogCompleted: Boolean(catalogLesson.completed),
    pendingTaskCount: catalogLesson.pendingTaskCount,
  };
}

export function pickNextLesson(catalogLessons, memoLessons, attempted, phase, dryRun = false) {
  return selectEligibleLessons({
    catalogLessons,
    memoLessons,
    activeIds: new Set(),
    attemptedIds: attempted,
    phase,
    dryRun,
    limit: 1,
  })[0] ?? null;
}

export function markPendingLessonWorkFailed(
  memo,
  course,
  lesson,
  { phase = null, detail, now = Date.now } = {},
) {
  const courseRecord = memo.courses.find(
    (candidate) => makeCourseKey(candidate) === makeCourseKey(course),
  );
  const record = courseRecord?.lessons.find(
    (candidate) => String(candidate.knowledgeId) === String(lesson.knowledgeId),
  );
  if (!record) {
    throw new Error(`备忘录中不存在课节 ${lesson.knowledgeId ?? lesson.title ?? ""}。`);
  }
  if (phase !== "homework" && videoNeedsWork(record.video)) {
    setLessonVideo(memo, course, lesson, { status: "failed", lastError: detail }, now);
  }
  if (phase !== "video" && homeworkNeedsWork(record.homework, { submitDryRun: true })) {
    setLessonHomework(memo, course, lesson, { status: "failed", lastError: detail }, now);
  }
  return record;
}

async function recordUnexpectedLessonFailure({ store, course, lesson, phase, detail, now }) {
  return store.mutate((memo) =>
    markPendingLessonWorkFailed(memo, course, lesson, { phase, detail, now }),
  );
}

async function playVideoTask({ page, course, lesson, task, store, config, now, progress, slot }) {
  progress.stage(slot, { name: "video", taskTitle: task.title, detail: "正在打开视频" });

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
    await playManifestVideo({
      frame: surface.frame,
      config,
      onProgress: async (state, { targetSeconds }) => {
        progress.video(slot, {
          currentTime: state.currentTime,
          duration: state.duration,
          targetSeconds,
          speed: config.videoSpeed,
        });
      },
      onPopupQuiz: async (result) => {
        progress.stage(slot, {
          name: "video-quiz",
          taskTitle: task.title,
          detail: result.detail ?? (result.status === "handling" ? "正在处理视频弹题" : "视频弹题已处理"),
        });
      },
    });
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

const HOMEWORK_MAX_ATTEMPTS = 3;

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
  progress,
  slot,
}) {
  try {
    await clickTaskTab(page, task);
  } catch (error) {
    await store.mutate((state) =>
      setLessonHomework(state, course, lesson, { status: "failed", lastError: error.message ?? String(error) }, now),
    );
    return false;
  }

  // 试错表：记录被判错、要求重答的答案组合，下次让大模型避开这些答案。
  const trials = Array.isArray(memoLesson.homework?.trials)
    ? memoLesson.homework.trials.slice()
    : [];
  const savedAnswers = memoLesson.homework?.lastAnswers ?? null;

  progress.stage(slot, { name: "homework", taskTitle: task.title, detail: "正在读取作业" });

  let attempts = 0;
  while (attempts < HOMEWORK_MAX_ATTEMPTS) {
    const surface = await waitForTaskSurface(page, config.timeoutMs, "assessment", task.title);
    if (!surface) {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: `作业“${task.title}”未加载出可见内容`, trials }, now),
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
        setLessonHomework(state, course, lesson, { status: "submitted", lastError: null, trials }, now),
      );
      return true;
    }
    if (platformState === "captcha") {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: "平台要求验证码，请人工完成提交", trials }, now),
      );
      return false;
    }
    if (memoLesson.homework?.status === "uncertain" && platformState === "unknown" && !dryRun) {
      await store.mutate((state) =>
        setLessonHomework(
          state,
          course,
          lesson,
          { status: "uncertain", lastError: "上次提交结果仍无法与平台对账，未盲目重复提交", trials },
          now,
        ),
      );
      return false;
    }

    let result;
    try {
      progress.stage(slot, { name: "homework", taskTitle: task.title, detail: "正在生成并填写答案" });
      result = await handleQuizWork({
        frame: surface.frame,
        page,
        config,
        dryRun,
        // 第一次尝试复用 dry-run 保存的答案；重试时由大模型结合试错表重新生成。
        precomputedAnswers: attempts === 0 && !dryRun ? savedAnswers : null,
        trials,
        beforeSubmit: async () => {
          progress.stage(slot, { name: "homework", taskTitle: task.title, detail: "正在提交作业" });
        },
      });
    } catch (error) {
      if (isDetachedError(error)) {
        await page.waitForTimeout(1_500);
        continue;
      }
      result = { status: "error", detail: error.message ?? String(error) };
    }

    if (result.reanswer) {
      // 本次答案被判错：记入试错表，换一组答案重试。
      if (Array.isArray(result.answers)) {
        trials.push(result.answers);
      }
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: result.detail, trials }, now),
      );
      if (attempts + 1 < HOMEWORK_MAX_ATTEMPTS) {
        progress.stage(slot, {
          name: "homework-retry",
          taskTitle: task.title,
          detail: `第 ${attempts + 2}/${HOMEWORK_MAX_ATTEMPTS} 次尝试`,
        });
      }
      attempts += 1;
      await page.waitForTimeout(1_500);
      continue;
    }

    const status = homeworkStatusFromResult(result);
    const patch = {
      status,
      lastError: ["submitted", "dry_run"].includes(status) ? null : result.detail,
      trials,
    };
    if (["submitted", "dry_run"].includes(status) && Array.isArray(result.answers)) {
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
      { status: "failed", lastError: "多次重答仍被要求重做，请人工处理", trials },
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
  progress,
  slot,
}) {
  const { tasks, surfaceFailure } = await discoverLessonTasks({
    page,
    course,
    lesson,
    timeoutMs: config.timeoutMs,
  });
  if (surfaceFailure) {
    progress.log(`      ⚠ ${surfaceFailure}`);
  }

  if (tasks.length === 0) {
    const detail = surfaceFailure ?? "课节页面中未发现任务标签";
    await store.mutate((state) =>
      markPendingLessonWorkFailed(state, course, lesson, { phase, detail, now }),
    );
    return { status: "failed", detail };
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

  let failure = null;
  if (phase !== "homework" && videoNeedsWork(memoLesson.video)) {
    for (const task of videoTasks) {
      const ok = await playVideoTask({ page, course, lesson, task, store, config, now, progress, slot });
      if (!ok) {
        failure = `视频“${task.title}”处理失败`;
        break;
      }
    }
  }

  // 视频失败后仍尝试作业（保留历史全流程行为），但课节整体仍报告失败。
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
        progress,
        slot,
      });
      if (!ok) {
        failure ??= `作业“${task.title}”处理失败`;
        break;
      }
    }
  }

  return failure ? { status: "failed", detail: failure } : { status: "done" };
}

async function processAssignedLesson({
  page,
  course,
  assignedLesson,
  store,
  config,
  dryRun,
  phase,
  now,
  progress,
  slot,
}) {
  progress.assign(slot, { lessonTitle: assignedLesson.label ?? assignedLesson.title });

  const { chapterFrame, lessons: catalogLessons } = await openCourseCatalog(
    page,
    course,
    config.timeoutMs,
  );
  const catalogLesson = catalogLessons.find(
    (candidate) => String(candidate.knowledgeId) === String(assignedLesson.knowledgeId),
  );
  if (!catalogLesson || isLockedLesson(catalogLesson)) {
    return { status: "locked" };
  }

  const courseRecord = await store.mutate((state) =>
    refreshCatalog(state, course, catalogLessons.map(toMemoLesson), now),
  );
  const memoLesson = courseRecord.lessons.find(
    (candidate) => String(candidate.knowledgeId) === String(assignedLesson.knowledgeId),
  );
  if (!memoLesson) {
    await store.mutate((state) =>
      markPendingLessonWorkFailed(state, course, assignedLesson, {
        phase,
        detail: "目录刷新后未找到课节记录",
        now,
      }),
    );
    return { status: "failed", detail: "目录刷新后未找到课节记录" };
  }

  const cardsFrame = await clickLessonInChapterFrame({
    chapterFrame,
    page,
    lesson: catalogLesson,
    timeoutMs: config.timeoutMs,
  });
  if (!cardsFrame) {
    await store.mutate((state) =>
      markPendingLessonWorkFailed(state, course, assignedLesson, {
        phase,
        detail: "课节打开后未找到内容帧",
        now,
      }),
    );
    return { status: "failed", detail: "课节打开后未找到内容帧" };
  }

  return processLesson({
    page,
    course,
    lesson: assignedLesson,
    memoLesson,
    store,
    config,
    dryRun,
    phase,
    now,
    progress,
    slot,
  });
}

async function processCourse({
  context,
  coordinatorPage,
  course,
  store,
  config,
  dryRun,
  phase,
  now,
  lessonsQuery,
  concurrency,
  progress,
}) {
  const workerPages = new Map();
  let courseStarted = false;

  try {
    await runDynamicWorkerPool({
      concurrency,
      keyOf: (lesson) => String(lesson.knowledgeId),
      loadCandidates: async ({ activeIds, attemptedIds }) => {
        const { lessons: catalogLessons } = await openCourseCatalog(
          coordinatorPage,
          course,
          config.timeoutMs,
        );
        const courseRecord = await store.mutate((state) =>
          refreshCatalog(state, course, catalogLessons.map(toMemoLesson), now),
        );
        if (!courseStarted) {
          progress.startCourse({
            name: course.name,
            total: filterLessonsByQuery(catalogLessons, lessonsQuery).length,
            concurrency,
          });
          courseStarted = true;
        }
        return selectEligibleLessons({
          catalogLessons,
          memoLessons: courseRecord.lessons,
          queries: lessonsQuery,
          activeIds,
          attemptedIds,
          phase,
          dryRun,
          limit: concurrency - activeIds.size,
        });
      },
      runItem: async (lesson, slot) => {
        const page = workerPages.get(slot) ?? await context.newPage();
        workerPages.set(slot, page);
        page.setDefaultTimeout(config.timeoutMs);
        page.setDefaultNavigationTimeout(config.timeoutMs);
        return processAssignedLesson({
          page,
          course,
          assignedLesson: lesson,
          store,
          config,
          dryRun,
          phase,
          now,
          progress,
          slot,
        });
      },
      onSettled: async ({ item, slot, status, value, reason }) => {
        const outcome =
          status === "rejected"
            ? { status: "failed", detail: reason?.message ?? String(reason) }
            : {
                status: value?.status ?? "failed",
                detail: value?.detail ?? `${item.label ?? item.title} 已处理`,
              };

        if (status === "rejected") {
          await recordUnexpectedLessonFailure({
            store,
            course,
            lesson: item,
            phase,
            detail: outcome.detail,
            now,
          });
        }

        progress.finish(slot, outcome);
        if (outcome.status === "failed" && progress.isTTY) {
          progress.warn(`页面 ${slot} ${item.label ?? item.title}：${outcome.detail ?? "处理失败"}`);
        }
        progress.release(slot);
      },
    });
  } finally {
    await Promise.allSettled(
      [...workerPages.values()].map((page) => page.close().catch(() => {})),
    );
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

export function buildStudyReport({
  memo,
  courseIds,
  dryRun,
  requestedPhase = null,
  fatalError = null,
  lessonsQuery = null,
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
        lessons: filterLessonsByQuery(course.lessons ?? [], lessonsQuery).map((lesson) => ({
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
  const progress = new StudyProgress();

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
      progress.log(`学习课程：${course.name}`);
      await processCourse({
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
