function parseSectionNumber(text) {
  const match = String(text ?? "").trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 1000 + (match[2] ? Number(match[2]) : 0);
}

function lessonSectionKey(lesson) {
  if (lesson.section) {
    return parseSectionNumber(lesson.section);
  }
  const prefix = String(lesson.title ?? "").match(/^(\d+(?:\.\d+)?)/);
  return prefix ? parseSectionNumber(prefix[1]) : null;
}

function lessonIdentity(lesson) {
  return lesson.knowledgeId ?? `${lesson.ordinal}`;
}

export function filterLessonsByQuery(lessons, queries) {
  if (!queries?.length) {
    return lessons;
  }
  const matched = new Set();
  const parts = queries.flatMap((query) =>
    String(query ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  );

  for (const part of parts) {
    const range = part.match(/^(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)$/);
    if (range) {
      const start = parseSectionNumber(range[1]);
      const end = parseSectionNumber(range[2]);
      if (start === null || end === null) {
        continue;
      }
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (const lesson of lessons) {
        const key = lessonSectionKey(lesson);
        if (key !== null && key >= low && key <= high) {
          matched.add(lessonIdentity(lesson));
        }
      }
      continue;
    }

    const isChapter = /^\d+$/.test(part);
    const target = parseSectionNumber(part);
    if (target === null) {
      continue;
    }
    for (const lesson of lessons) {
      const key = lessonSectionKey(lesson);
      if (key === null) {
        continue;
      }
      if (isChapter) {
        if (Math.floor(key / 1000) === Math.floor(target / 1000)) {
          matched.add(lessonIdentity(lesson));
        }
      } else if (key === target) {
        matched.add(lessonIdentity(lesson));
      }
    }
  }

  return lessons.filter((lesson) => matched.has(lessonIdentity(lesson)));
}
