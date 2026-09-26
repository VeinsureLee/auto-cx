import { refreshCatalog } from "../persistence/memo.mjs";
import { clickLessonInChapterFrame, isLockedLesson, openCourseCatalog } from "../platform/task-manifest.mjs";
import { filterLessonsByQuery, runDynamicWorkerPool, selectEligibleLessons } from "./scheduler.mjs";
import { markPendingLessonWorkFailed, processLesson } from "./lesson.mjs";

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

async function recordUnexpectedLessonFailure({ store, course, lesson, phase, detail, now }) {
  return store.mutate((memo) =>
    markPendingLessonWorkFailed(memo, course, lesson, { phase, detail, now }),
  );
}

// 课节执行顺序：作业门通过后才允许视频；显式阶段例外。

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

export async function processCourse({
  browser,
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
  let browserFailure = null;
  const onBrowserDisconnected = () => {
    browserFailure ??= new Error("Chromium 浏览器连接已断开。");
  };
  const onContextClosed = () => {
    if (!progress.interrupted) browserFailure ??= new Error("Chromium 浏览器上下文已关闭。");
  };
  browser.on("disconnected", onBrowserDisconnected);
  context.on("close", onContextClosed);

  try {
    await runDynamicWorkerPool({
      concurrency,
      shouldStop: () => progress.interrupted || browserFailure !== null,
      getStopError: () => progress.interruptionError ?? browserFailure ?? new Error("学习任务已停止。"),
      isFatalError: () => progress.interrupted || browserFailure !== null ||
        browser.isConnected?.() === false || context.isClosed?.() === true,
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
    browser.removeListener("disconnected", onBrowserDisconnected);
    context.removeListener("close", onContextClosed);
    await Promise.allSettled(
      [...workerPages.values()].map((page) => page.close().catch(() => {})),
    );
  }
}
