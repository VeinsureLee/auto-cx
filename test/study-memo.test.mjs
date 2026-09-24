import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StudyMemoStore,
  createStudyMemo,
  lessonNeedsWork,
  lessonStatusLabel,
  refreshCatalog,
  setLessonHomework,
  setLessonVideo,
  validateStudyMemo,
} from "../src/study-memo.mjs";

const course = {
  courseId: "course-1",
  clazzId: "class-1",
  name: "课程一",
  url: "https://example.test/course-1",
};

function catalogLesson(overrides = {}) {
  return {
    knowledgeId: "lesson-1",
    title: "1.1",
    ordinal: 1,
    locked: false,
    catalogCompleted: false,
    pendingTaskCount: 2,
    ...overrides,
  };
}

test("refreshCatalog seeds lessons without losing existing video/homework progress", () => {
  const memo = createStudyMemo({ courses: [course] });
  refreshCatalog(memo, course, [catalogLesson()]);
  const lesson = memo.courses[0].lessons[0];

  setLessonVideo(memo, course, lesson, { status: "done" });

  refreshCatalog(memo, course, [catalogLesson({ title: "1.1 新标题" })]);
  const refreshed = memo.courses[0].lessons[0];
  assert.equal(refreshed.title, "1.1 新标题");
  assert.equal(refreshed.video.status, "done");
  assert.equal(refreshed.homework.status, "pending");
});

test("lessonNeedsWork respects the catalog-completed flag and phase", () => {
  const memo = createStudyMemo({ courses: [course] });
  refreshCatalog(memo, course, [
    catalogLesson({ knowledgeId: "a", catalogCompleted: true }),
    catalogLesson({ knowledgeId: "b" }),
    catalogLesson({ knowledgeId: "c", locked: true }),
  ]);
  const [completed, pending, locked] = memo.courses[0].lessons;

  assert.deepEqual(lessonNeedsWork(completed), { video: false, homework: false, any: false });
  assert.deepEqual(lessonNeedsWork(pending), { video: true, homework: true, any: true });
  // 锁定状态由外层协调器跳过；lessonNeedsWork 只按完成情况判断。
  assert.deepEqual(lessonNeedsWork(locked), { video: true, homework: true, any: true });

  assert.deepEqual(lessonNeedsWork(pending, { phase: "video" }), {
    video: true,
    homework: false,
    any: true,
  });
  assert.deepEqual(lessonNeedsWork(pending, { phase: "homework" }), {
    video: false,
    homework: true,
    any: true,
  });
});

test("lessonNeedsWork treats dry_run as pending when submitting for real", () => {
  const memo = createStudyMemo({ courses: [course] });
  refreshCatalog(memo, course, [catalogLesson({ knowledgeId: "a" })]);
  const lesson = memo.courses[0].lessons[0];
  setLessonHomework(memo, course, lesson, {
    status: "dry_run",
    lastAnswers: [{ index: 1, type: "judge", trueFalse: true }],
  });

  assert.deepEqual(lessonNeedsWork(lesson, { phase: "homework", submitDryRun: false }), {
    video: false,
    homework: false,
    any: false,
  });
  assert.deepEqual(lessonNeedsWork(lesson, { phase: "homework", submitDryRun: true }), {
    video: false,
    homework: true,
    any: true,
  });
});

test("lessonStatusLabel reports completed, locked, done, and failed states", () => {
  const memo = createStudyMemo({ courses: [course] });
  refreshCatalog(memo, course, [
    catalogLesson({ knowledgeId: "a", catalogCompleted: true }),
    catalogLesson({ knowledgeId: "b", locked: true }),
    catalogLesson({ knowledgeId: "c" }),
    catalogLesson({ knowledgeId: "d" }),
  ]);
  const [completed, locked, pending, failed] = memo.courses[0].lessons;

  assert.equal(lessonStatusLabel(completed), "completed");
  assert.equal(lessonStatusLabel(locked), "locked");
  assert.equal(lessonStatusLabel(pending), "pending");

  setLessonVideo(memo, course, failed, { status: "done" });
  setLessonHomework(memo, course, failed, { status: "failed", lastError: "验证码" });
  assert.equal(lessonStatusLabel(failed), "failed");
});

test("validateStudyMemo rejects unknown durable statuses", () => {
  const memo = createStudyMemo({ courses: [course] });
  refreshCatalog(memo, course, [catalogLesson()]);
  memo.courses[0].lessons[0].video.status = "watched-ish";
  assert.throws(() => validateStudyMemo(memo), /视频状态无效/);
});

test("StudyMemoStore atomically round-trips JSON and derived Markdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chaoxing-memo-"));
  const filePath = path.join(directory, "memo.json");
  const markdownPath = path.join(directory, "memo.md");
  try {
    const store = await StudyMemoStore.open({
      filePath,
      markdownPath,
      courses: [course],
      courseQueries: ["课程一"],
    });
    await store.mutate((state) => {
      refreshCatalog(state, course, [catalogLesson()]);
      setLessonVideo(state, course, { knowledgeId: "lesson-1" }, { status: "done" });
    });

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    const markdown = await readFile(markdownPath, "utf8");
    assert.equal(persisted.courses[0].lessons[0].video.status, "done");
    assert.match(markdown, /超星学习备忘录/);
    assert.ok(markdown.includes("done"));
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ["memo.json", "memo.md"],
      "temporary files should be renamed away",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
