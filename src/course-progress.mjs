const CHAPTER_NAV = 'a[data-url*="/mycourse/studentcourse"]';
const LESSON_ITEM = ".chapter_item:has(.catalog_name.newCatalog_name a.clicktitle)";

export async function waitForChapterFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let frameUrl;
      try {
        frameUrl = new URL(frame.url());
      } catch {
        continue;
      }
      if (frameUrl.pathname.endsWith("/mycourse/studentcourse")) {
        return frame;
      }
    }
    await page.waitForTimeout(200);
  }

  throw new Error("未能加载课程章节目录。");
}

export function summarizeLessons(lessons) {
  const completed = lessons.filter((lesson) => lesson.status === "completed").length;
  return {
    completed,
    completionPercent: lessons.length === 0 ? 0 : Number(((completed / lessons.length) * 100).toFixed(2)),
    notCompleted: lessons.length - completed,
    total: lessons.length,
  };
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function listLessons(chapterFrame, timeoutMs) {
  const lessonItems = chapterFrame.locator(LESSON_ITEM);
  await lessonItems.first().waitFor({ state: "attached", timeout: timeoutMs });

  return lessonItems.evaluateAll((items) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() || "";

    return items.map((item) => {
      const titleElement = item.querySelector(".catalog_name.newCatalog_name a.clicktitle");
      const section = normalize(titleElement?.querySelector(".catalog_sbar")?.textContent);
      const title = normalize(item.getAttribute("title") || titleElement?.textContent);
      const progressText = normalize(item.querySelector(".catalog_jindu")?.textContent);
      const pendingMatch = progressText.match(/(\d+)\s*个待完成任务点/);
      const completed = item.querySelector(".catalog_state.icon_yiwanc") !== null;

      return {
        completed,
        knowledgeId: item.id?.startsWith("cur") ? item.id.slice(3) : item.id || null,
        label: section && !title.startsWith(section) ? `${section} ${title}` : title,
        pendingTaskCount: pendingMatch ? Number(pendingMatch[1]) : null,
        progressText: progressText || null,
        section: section || null,
        status: completed ? "completed" : "not_completed",
        title,
      };
    });
  });
}

export async function collectCourseProgress(context, course, timeoutMs) {
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  try {
    await page.goto(course.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const chapterNav = page.locator(CHAPTER_NAV);
    await chapterNav.waitFor({ state: "visible", timeout: timeoutMs });
    await chapterNav.click();

    const chapterFrame = await waitForChapterFrame(page, timeoutMs);
    const lessons = await listLessons(chapterFrame, timeoutMs);

    return {
      clazzId: course.clazzId,
      courseId: course.courseId,
      name: course.name,
      summary: summarizeLessons(lessons),
      lessons: lessons.map(({ completed, ...lesson }) => lesson),
    };
  } finally {
    await page.close();
  }
}

export async function collectProgressWithConcurrency(
  context,
  courses,
  concurrency,
  timeoutMs,
) {
  return mapWithConcurrency(courses, concurrency, (course) =>
    collectCourseProgress(context, course, timeoutMs),
  );
}

export function escapeMarkdownCell(value) {
  return String(value ?? "-").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderProgressMarkdown(report) {
  const lines = [
    "# 超星课程进度表",
    "",
    `更新时间：${report.generatedAt}`,
    "",
  ];

  for (const course of report.courses) {
    lines.push(
      `## ${course.name}`,
      "",
      `- 总课节：${course.summary.total}`,
      `- 已完成：${course.summary.completed}`,
      `- 未完成：${course.summary.notCompleted}`,
      `- 完成率：${course.summary.completionPercent}%`,
      "",
      "| 状态 | 课节 | 待完成任务点 |",
      "| --- | --- | ---: |",
    );

    for (const lesson of course.lessons) {
      lines.push(
        `| ${lesson.status === "completed" ? "已完成" : "未完成"} | ${escapeMarkdownCell(lesson.label)} | ${escapeMarkdownCell(lesson.pendingTaskCount)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
