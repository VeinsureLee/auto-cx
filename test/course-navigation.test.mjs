import assert from "node:assert/strict";
import test from "node:test";

import { selectTargetCourse } from "../src/course-navigation.mjs";

const courses = [
  { courseId: "1", name: "创新创业基础" },
  { courseId: "2", name: "《科研诚信与学术规范》（2026-2027学年 第一学期）" },
];

test("selectTargetCourse supports a unique partial course name", () => {
  assert.equal(selectTargetCourse(courses, "科研诚信").courseId, "2");
});

test("selectTargetCourse rejects a missing course", () => {
  assert.throws(() => selectTargetCourse(courses, "不存在"), /未找到/);
});

test("selectTargetCourse rejects an ambiguous partial name", () => {
  assert.throws(
    () => selectTargetCourse([...courses, { courseId: "3", name: "科研诚信专题" }], "科研诚信"),
    /匹配到多门课程/,
  );
});
