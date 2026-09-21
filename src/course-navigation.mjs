import { findCourseFrame } from "./courses.mjs";

const COURSE_ITEM = "#courseList .course.learnCourse";
const CHAPTER_NAV = 'a[data-url*="/mycourse/studentcourse"]';
const LESSON_ITEM = ".catalog_name.newCatalog_name a.clicktitle";

function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() || "";
}

export function selectTargetCourse(courses, query) {
  const normalizedQuery = normalizeText(query);
  const exactMatches = courses.filter(
    (course) => normalizeText(course.name) === normalizedQuery,
  );
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const partialMatches = courses.filter((course) =>
    normalizeText(course.name).includes(normalizedQuery),
  );
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  if (partialMatches.length > 1) {
    throw new Error(`课程关键字“${query}”匹配到多门课程，请提供更完整的名称。`);
  }

  throw new Error(`未找到名称包含“${query}”的未完成课程。`);
}

async function waitForFrame(page, predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let frameUrl;
      try {
        frameUrl = new URL(frame.url());
      } catch {
        continue;
      }
      if (predicate(frameUrl)) {
        return frame;
      }
    }
    await page.waitForTimeout(200);
  }

  throw new Error(`未能加载${description}。`);
}

async function findCourseCard(frame, courseId) {
  const cards = frame.locator(COURSE_ITEM);
  const count = await cards.count();

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const currentCourseId = await card
      .locator("input.courseId")
      .inputValue()
      .catch(() => "");
    if (currentCourseId === courseId) {
      return card;
    }
  }

  throw new Error(`课程列表中未找到课程 ID ${courseId}。`);
}

async function findLesson(frame, targetLesson, timeoutMs) {
  const lessons = frame.locator(LESSON_ITEM);
  await lessons.first().waitFor({ state: "visible", timeout: timeoutMs });

  const lessonTexts = await lessons.allTextContents();
  const normalizedTarget = normalizeText(targetLesson);
  let lessonIndex = lessonTexts.findIndex(
    (lessonText) => normalizeText(lessonText) === normalizedTarget,
  );
  if (lessonIndex === -1) {
    lessonIndex = lessonTexts.findIndex((lessonText) =>
      normalizeText(lessonText).includes(normalizedTarget),
    );
  }
  if (lessonIndex === -1) {
    throw new Error(`章节列表中未找到课节“${targetLesson}”。`);
  }

  return {
    locator: lessons.nth(lessonIndex),
    title: normalizeText(lessonTexts[lessonIndex]),
  };
}

export async function openTargetLesson({
  context,
  course,
  lessonTitle,
  page,
  timeoutMs,
}) {
  const courseFrame = await findCourseFrame(page, timeoutMs);
  const courseCard = await findCourseCard(courseFrame, course.courseId);
  const courseLink = courseCard.locator(".course-info h3 a[href]").first();
  await courseLink.waitFor({ state: "visible", timeout: timeoutMs });

  const [coursePage] = await Promise.all([
    context.waitForEvent("page", { timeout: timeoutMs }),
    courseLink.click(),
  ]);
  await coursePage.waitForLoadState("domcontentloaded", { timeout: timeoutMs });

  const chapterNav = coursePage.locator(CHAPTER_NAV);
  await chapterNav.waitFor({ state: "visible", timeout: timeoutMs });
  await chapterNav.click();

  const chapterFrame = await waitForFrame(
    coursePage,
    (url) => url.pathname.endsWith("/mycourse/studentcourse"),
    timeoutMs,
    "章节列表",
  );
  const lesson = await findLesson(chapterFrame, lessonTitle, timeoutMs);
  await lesson.locator.click();

  await coursePage.waitForURL(
    (url) =>
      url.hostname === "mooc1.chaoxing.com" &&
      url.pathname.includes("/mycourse/studentstudy"),
    { timeout: timeoutMs },
  );
  await waitForFrame(
    coursePage,
    (url) => url.pathname.includes("/mooc-ans/knowledge/cards"),
    timeoutMs,
    "课节内容",
  );

  return { lessonTitle: lesson.title };
}
