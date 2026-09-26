import assert from "node:assert/strict";
import test from "node:test";

import { createStudyMemo, refreshCatalog, setLessonVideo } from "../src/study-memo.mjs";
import {
  filterCoursesByQuery,
  filterLessonsByQuery,
  lessonExecutionOrder,
  markPendingLessonWorkFailed,
  pickNextLesson,
  processLesson,
} from "../src/study.mjs";

const courses = [
  { courseId: "1", name: "创新创业基础" },
  { courseId: "2", name: "《科研诚信与学术规范》（2026-2027学年 第一学期）" },
  { courseId: "3", name: "创新创业实战" },
];

test("filterCoursesByQuery returns all courses when no queries", () => {
  assert.equal(filterCoursesByQuery(courses, []), courses);
  assert.equal(filterCoursesByQuery(courses), courses);
});

test("filterCoursesByQuery selects courses containing each keyword", () => {
  assert.deepEqual(
    filterCoursesByQuery(courses, ["科研诚信"]).map((course) => course.courseId),
    ["2"],
  );
});

test("filterCoursesByQuery keeps the original course order and deduplicates", () => {
  assert.deepEqual(
    filterCoursesByQuery(courses, ["创新"]).map((course) => course.courseId),
    ["1", "3"],
  );
  assert.deepEqual(
    filterCoursesByQuery(courses, ["创新", "创业基础"]).map((course) => course.courseId),
    ["1", "3"],
  );
});

test("filterCoursesByQuery throws when no course matches a keyword", () => {
  assert.throws(() => filterCoursesByQuery(courses, ["不存在"]), /未找到名称包含/);
});

test("filterCoursesByQuery supports comma-separated style queries", () => {
  assert.deepEqual(
    filterCoursesByQuery(courses, ["科研诚信, 创新创业实战"]).map((course) => course.courseId),
    ["2", "3"],
  );
});

function catalog(knowledgeId, { completed = false, locked = false } = {}) {
  return {
    knowledgeId,
    completed,
    progressText: locked ? "需完成之前闯关任务点，该章节才能解锁" : "2个待完成任务点",
  };
}

function memoLesson(knowledgeId, { catalogCompleted = false, video = "pending", homework = "pending" } = {}) {
  return {
    knowledgeId,
    catalogCompleted,
    locked: false,
    video: { status: video },
    homework: { status: homework },
  };
}

test("pickNextLesson picks the first incomplete, unlocked lesson needing work", () => {
  const catalogLessons = [catalog("a", { completed: true }), catalog("b"), catalog("c")];
  const memoLessons = [
    memoLesson("a", { catalogCompleted: true }),
    memoLesson("b"),
    memoLesson("c"),
  ];
  const target = pickNextLesson(catalogLessons, memoLessons, new Set(), null);
  assert.equal(target.knowledgeId, "b");
});

test("pickNextLesson skips locked lessons and already-attempted lessons", () => {
  const catalogLessons = [catalog("a"), catalog("b", { locked: true }), catalog("c")];
  const memoLessons = [memoLesson("a"), memoLesson("b"), memoLesson("c")];
  const target = pickNextLesson(catalogLessons, memoLessons, new Set(["a"]), null);
  assert.equal(target.knowledgeId, "c");
});

test("pickNextLesson skips lessons whose memo is already done", () => {
  const catalogLessons = [catalog("a"), catalog("b")];
  const memoLessons = [
    memoLesson("a", { video: "done", homework: "submitted" }),
    memoLesson("b"),
  ];
  const target = pickNextLesson(catalogLessons, memoLessons, new Set(), null);
  assert.equal(target.knowledgeId, "b");
});

test("pickNextLesson respects the video-only phase", () => {
  const catalogLessons = [catalog("a"), catalog("b")];
  const memoLessons = [
    memoLesson("a", { video: "done", homework: "pending" }),
    memoLesson("b", { video: "pending", homework: "submitted" }),
  ];
  const target = pickNextLesson(catalogLessons, memoLessons, new Set(), "video");
  assert.equal(target.knowledgeId, "b");
});

test("pickNextLesson respects the homework-only phase", () => {
  const catalogLessons = [catalog("a"), catalog("b")];
  const memoLessons = [
    memoLesson("a", { video: "pending", homework: "submitted" }),
    memoLesson("b", { video: "done", homework: "pending" }),
  ];
  const target = pickNextLesson(catalogLessons, memoLessons, new Set(), "homework");
  assert.equal(target.knowledgeId, "b");
});

test("pickNextLesson submits dry_run lessons on a real run", () => {
  const catalogLessons = [catalog("a"), catalog("b")];
  const memoLessons = [
    memoLesson("a", { video: "done", homework: "dry_run" }),
    memoLesson("b", { video: "done", homework: "pending" }),
  ];
  const target = pickNextLesson(catalogLessons, memoLessons, new Set(), "homework", false);
  assert.equal(target.knowledgeId, "a");
});

function numberedLesson(section, knowledgeId) {
  return { knowledgeId, section, title: `${section} 标题`, ordinal: Number(knowledgeId) };
}

test("filterLessonsByQuery selects by section, range, chapter, and list", () => {
  const lessons = [
    numberedLesson("8.5", "801"),
    numberedLesson("9.1", "901"),
    numberedLesson("9.2", "902"),
    numberedLesson("9.5", "905"),
    numberedLesson("10.2", "1002"),
    numberedLesson("11.1", "1101"),
  ];

  assert.deepEqual(filterLessonsByQuery(lessons, ["9.1"]).map((l) => l.knowledgeId), ["901"]);
  assert.deepEqual(
    filterLessonsByQuery(lessons, ["9.1-9.5"]).map((l) => l.knowledgeId),
    ["901", "902", "905"],
  );
  assert.deepEqual(filterLessonsByQuery(lessons, ["9"]).map((l) => l.knowledgeId), [
    "901",
    "902",
    "905",
  ]);
  assert.deepEqual(
    filterLessonsByQuery(lessons, ["9.1,10.2"]).map((l) => l.knowledgeId),
    ["901", "1002"],
  );
  assert.equal(filterLessonsByQuery(lessons, []), lessons);
});

test("filterLessonsByQuery falls back to the title section prefix", () => {
  const lessons = [
    { knowledgeId: "1", title: "9.3 标题" },
    { knowledgeId: "2", title: "10.1 标题" },
  ];
  assert.deepEqual(filterLessonsByQuery(lessons, ["9.3"]).map((l) => l.knowledgeId), ["1"]);
  assert.deepEqual(filterLessonsByQuery(lessons, ["10"]).map((l) => l.knowledgeId), ["2"]);
});

test("markPendingLessonWorkFailed preserves completed work and fails pending work", () => {
  const course = { courseId: "1", clazzId: "2", name: "课程" };
  const state = createStudyMemo({ courses: [course] });
  refreshCatalog(state, course, [{
    knowledgeId: "1.1",
    title: "1.1 标题",
    ordinal: 1,
    locked: false,
    catalogCompleted: false,
    pendingTaskCount: 2,
  }]);
  setLessonVideo(state, course, { knowledgeId: "1.1" }, { status: "done" });

  markPendingLessonWorkFailed(
    state,
    course,
    { knowledgeId: "1.1" },
    { phase: null, detail: "页面已关闭", now: () => new Date(0) },
  );

  const lesson = state.courses[0].lessons[0];
  assert.equal(lesson.video.status, "done");
  assert.equal(lesson.homework.status, "failed");
  assert.equal(lesson.homework.lastError, "页面已关闭");
});

// ---- lessonExecutionOrder：作业门决定视频是否播放 ----

test("normal lesson order gates video on successful homework", () => {
  assert.deepEqual(
    lessonExecutionOrder({ phase: null, homeworkResult: { success: true }, videoTaskCount: 2 }),
    ["homework", "video"],
  );
  assert.deepEqual(
    lessonExecutionOrder({ phase: null, homeworkResult: { success: false }, videoTaskCount: 2 }),
    ["homework", "blocked-video"],
  );
});

test("phase video bypasses homework only when explicitly requested", () => {
  assert.deepEqual(
    lessonExecutionOrder({ phase: "video", homeworkResult: { success: false }, videoTaskCount: 1 }),
    ["video"],
  );
  assert.deepEqual(
    lessonExecutionOrder({ phase: "homework", homeworkResult: { success: true }, videoTaskCount: 2 }),
    ["homework"],
  );
  assert.deepEqual(
    lessonExecutionOrder({ phase: null, homeworkResult: { success: true }, videoTaskCount: 0 }),
    ["homework"],
  );
});

// ---- processLesson：作业优先、失败短路、阶段例外 ----

function makeTask(kind, title, ordinal) {
  return { key: `${kind}-${ordinal}`, kind, tabId: `dct${ordinal}`, cardId: null, ordinal, title };
}

function createLessonHarness({
  tasks = [],
  surfaceFailure = null,
  video = "pending",
  homework = "pending",
  phase = null,
  dryRun = false,
} = {}) {
  const course = { courseId: "1", clazzId: "2", name: "课程" };
  const state = createStudyMemo({ courses: [course], now: () => new Date(0) });
  refreshCatalog(
    state,
    course,
    [{
      knowledgeId: "901",
      title: "9.1 标题",
      ordinal: 1,
      locked: false,
      catalogCompleted: false,
      pendingTaskCount: 2,
    }],
    () => new Date(0),
  );
  const lesson = { knowledgeId: "901", title: "9.1 标题", ordinal: 1 };
  const memoLesson = state.courses[0].lessons[0];
  memoLesson.video = { status: video, lastError: null, updatedAt: null };
  memoLesson.homework = { status: homework, lastError: null, updatedAt: null };

  const calls = [];
  const store = { state, mutate: async (updater) => updater(state) };
  const progress = {
    logs: [],
    log(message) {
      this.logs.push(message);
    },
    stage() {},
    video() {},
  };
  const deps = {
    discoverTasks: async () => ({ tasks, surfaceFailure }),
    runHomeworkTask: async ({ task }) => {
      calls.push(`homework:${task.title}`);
      return true;
    },
    runVideoTask: async ({ task, taskPointReader }) => {
      assert.equal(typeof taskPointReader, "function", "视频任务必须拿到任务点读取器");
      calls.push(`video:${task.title}`);
      return true;
    },
  };

  return {
    calls,
    state,
    progress,
    memoLesson,
    run: (overrides = {}) =>
      processLesson({
        page: {},
        course,
        lesson,
        memoLesson,
        store,
        config: { timeoutMs: 1_000, videoSpeed: 1 },
        dryRun,
        phase,
        now: () => new Date(0),
        progress,
        slot: 1,
        deps: { ...deps, ...overrides },
      }),
  };
}

test("processLesson runs homework before ordered videos in normal mode", async () => {
  const harness = createLessonHarness({
    tasks: [
      makeTask("video", "视频二", 3),
      makeTask("assessment", "作业", 2),
      makeTask("video", "视频一", 1),
    ],
  });

  const result = await harness.run();

  assert.equal(result.status, "done");
  // 作业门先行；视频按清单顺序（而非序号）逐一播放。
  assert.deepEqual(harness.calls, ["homework:作业", "video:视频二", "video:视频一"]);
});

test("processLesson homework failure skips all videos", async () => {
  const harness = createLessonHarness({
    tasks: [makeTask("assessment", "作业", 1), makeTask("video", "视频一", 2)],
  });

  const result = await harness.run({
    runHomeworkTask: async ({ task }) => {
      harness.calls.push(`homework:${task.title}`);
      return false;
    },
  });

  assert.deepEqual(result, { status: "failed", detail: "作业“作业”处理失败" });
  assert.deepEqual(harness.calls, ["homework:作业"]);
});

test("processLesson dry-run homework success permits video", async () => {
  const harness = createLessonHarness({
    tasks: [makeTask("assessment", "作业", 1), makeTask("video", "视频一", 2)],
    dryRun: true,
  });

  const result = await harness.run();

  assert.equal(result.status, "done");
  assert.deepEqual(harness.calls, ["homework:作业", "video:视频一"]);
});

test("processLesson phase video plays video without homework", async () => {
  const harness = createLessonHarness({
    tasks: [makeTask("assessment", "作业", 1), makeTask("video", "视频一", 2)],
    phase: "video",
  });

  const result = await harness.run({
    runHomeworkTask: async () => {
      throw new Error("video 阶段不得运行作业");
    },
  });

  assert.equal(result.status, "done");
  assert.deepEqual(harness.calls, ["video:视频一"]);
});

test("processLesson phase homework never invokes video", async () => {
  const harness = createLessonHarness({
    tasks: [makeTask("assessment", "作业", 1), makeTask("video", "视频一", 2)],
    phase: "homework",
  });

  const result = await harness.run({
    runVideoTask: async () => {
      throw new Error("homework 阶段不得播放视频");
    },
  });

  assert.equal(result.status, "done");
  assert.deepEqual(harness.calls, ["homework:作业"]);
});

test("processLesson marks homework none when the lesson has no assessment task", async () => {
  const harness = createLessonHarness({ tasks: [makeTask("video", "视频一", 1)] });

  const result = await harness.run();

  assert.equal(result.status, "done");
  assert.equal(harness.state.courses[0].lessons[0].homework.status, "none");
  assert.deepEqual(harness.calls, ["video:视频一"]);
});

test("processLesson marks video none when the lesson has no video task", async () => {
  const harness = createLessonHarness({ tasks: [makeTask("assessment", "作业", 1)] });

  const result = await harness.run();

  assert.equal(result.status, "done");
  assert.equal(harness.state.courses[0].lessons[0].video.status, "none");
  assert.deepEqual(harness.calls, ["homework:作业"]);
});

test("processLesson persists failure for a task-less lesson instead of marking none", async () => {
  const surfaceFailure = "课节页面中未发现任务标签（li[id^=dct]），请校准 study-selectors.mjs 的 taskTab 选择器";
  const harness = createLessonHarness({ tasks: [], surfaceFailure });

  const result = await harness.run();

  assert.deepEqual(result, { status: "failed", detail: surfaceFailure });
  assert.ok(harness.progress.logs.some((message) => message.includes(surfaceFailure)));
  const memoLesson = harness.state.courses[0].lessons[0];
  assert.equal(memoLesson.video.status, "failed");
  assert.equal(memoLesson.homework.status, "failed");
});

test("processLesson skips work already recorded as done", async () => {
  const harness = createLessonHarness({
    tasks: [makeTask("assessment", "作业", 1), makeTask("video", "视频一", 2)],
    homework: "submitted",
  });

  const result = await harness.run();

  assert.equal(result.status, "done");
  // 作业已提交：直接放行视频，不再重复处理作业。
  assert.deepEqual(harness.calls, ["video:视频一"]);
});

test("processLesson resubmits dry_run homework on a formal run", async () => {
  const harness = createLessonHarness({
    tasks: [makeTask("assessment", "作业", 1), makeTask("video", "视频一", 2)],
    homework: "dry_run",
    dryRun: false,
  });

  const result = await harness.run();

  assert.equal(result.status, "done");
  assert.deepEqual(harness.calls, ["homework:作业", "video:视频一"]);
});

test("processLesson does not replay a video already done", async () => {
  const harness = createLessonHarness({
    tasks: [makeTask("assessment", "作业", 1), makeTask("video", "视频一", 2)],
    video: "done",
  });

  const result = await harness.run();

  assert.equal(result.status, "done");
  assert.deepEqual(harness.calls, ["homework:作业"]);
});
