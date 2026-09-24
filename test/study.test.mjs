import assert from "node:assert/strict";
import test from "node:test";

import { filterCoursesByQuery, pickNextLesson } from "../src/study.mjs";

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