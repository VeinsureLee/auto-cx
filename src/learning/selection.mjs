import { readFile } from "node:fs/promises";
import { makeCourseKey } from "../persistence/memo.mjs";
import { selectEligibleLessons } from "./scheduler.mjs";

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

export async function loadSelectedCourses(config, coursesQuery) {
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
