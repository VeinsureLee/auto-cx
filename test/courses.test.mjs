import assert from "node:assert/strict";
import test from "node:test";

import { filterIncompleteCourses } from "../src/courses.mjs";

test("filterIncompleteCourses keeps only active courses below 100%", () => {
  const courses = [
    { completed: false, courseId: "active", ended: false, name: "进行中的课程" },
    { completed: true, courseId: "done", ended: false, name: "已完成任务点的课程" },
    { completed: false, courseId: "ended", ended: true, name: "已经结束的课程" },
  ];

  assert.deepEqual(filterIncompleteCourses(courses), [
    { courseId: "active", name: "进行中的课程" },
  ]);
});
