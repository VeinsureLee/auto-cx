import { makeCourseKey, lessonStatusLabel } from "./memo.mjs";
import { filterLessonsByQuery } from "../shared/lesson-filter.mjs";

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

