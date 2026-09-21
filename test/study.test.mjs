import assert from "node:assert/strict";
import test from "node:test";

import { filterCoursesByQuery } from "../src/study.mjs";

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