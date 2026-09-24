import { listLessons, waitForChapterFrame } from "./course-progress.mjs";
import { STUDY_SELECTORS } from "./study-selectors.mjs";

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function makeTaskKey({ courseId, clazzId, knowledgeId, cardId, tabId, ordinal }) {
  const prefix = [courseId, clazzId, knowledgeId].map((part) => String(part ?? "")).join(":");
  const stablePart = cardId ? `card:${cardId}` : `tab:${tabId ?? "unknown"}:${ordinal ?? 0}`;
  return `${prefix}:${stablePart}`;
}

export function isLockedLesson(lesson) {
  return normalize(lesson?.progressText).includes("需完成之前闯关任务点");
}

export function extractCardId(attributes = {}) {
  const directNames = ["data-cardid", "data-card-id", "cardid", "card-id"];
  for (const name of directNames) {
    const value = normalize(attributes[name]);
    if (/^\d+$/.test(value)) {
      return value;
    }
  }
  for (const name of ["data-card", "data-id", "data"]) {
    const value = normalize(attributes[name]);
    if (/^\d{6,}$/.test(value)) {
      return value;
    }
  }

  const text = Object.values(attributes).map(normalize).filter(Boolean).join(" ");
  const namedMatch = text.match(/(?:card[_-]?id|cardid)\s*[=:,'"()\s]+\s*(\d+)/i);
  if (namedMatch) {
    return namedMatch[1];
  }

  const callMatch = normalize(attributes.onclick).match(/(?:changeDisplay|changeCard)[^(]*\([^)]*?\b(\d{6,})\b/i);
  if (callMatch) {
    return callMatch[1];
  }
  return null;
}

export function classifyTaskKind({ title, moduleType, hasInlineQuiz = false }) {
  const normalizedTitle = normalize(title);
  // 超星的“作业”等标签名称比切换瞬间仍残留的旧 iframe 更可靠。
  if (/作业|测验|考试/.test(normalizedTitle)) return "assessment";
  if (/视频/.test(normalizedTitle)) return "video";
  if (/音频|声音/.test(normalizedTitle)) return "audio";
  if (/文档|阅读|资料/.test(normalizedTitle)) return "document";

  if (moduleType === "video") return "video";
  if (moduleType === "audio") return "audio";
  if (moduleType === "doc") return "document";
  if (moduleType === "quiz" || hasInlineQuiz) return "assessment";
  return "other";
}

function moduleTypeForFrame(frame) {
  let pathname;
  try {
    pathname = new URL(frame.url()).pathname;
  } catch {
    return null;
  }
  return STUDY_SELECTORS.moduleFrames.find((candidate) => pathname.includes(candidate.path))?.type ?? null;
}

async function frameIsVisible(frame) {
  const element = await frame.frameElement().catch(() => null);
  return Boolean(element && (await element.isVisible().catch(() => false)));
}

export async function waitForCardsFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let pathname;
      try {
        pathname = new URL(frame.url()).pathname;
      } catch {
        continue;
      }
      if (pathname.includes(STUDY_SELECTORS.cardsFramePath)) {
        return frame;
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

export async function openCourseCatalog(page, course, timeoutMs) {
  await page.goto(course.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const chapterNav = page.locator(STUDY_SELECTORS.chapterNav);
  await chapterNav.waitFor({ state: "visible", timeout: timeoutMs });
  await chapterNav.click();
  const chapterFrame = await waitForChapterFrame(page, timeoutMs);
  const lessons = await listLessons(chapterFrame, timeoutMs);
  return {
    chapterFrame,
    lessons: lessons.map((lesson, index) => ({ ...lesson, ordinal: index + 1 })),
  };
}

export async function clickLessonInChapterFrame({ chapterFrame, page, lesson, timeoutMs }) {
  const lessonItems = chapterFrame.locator(STUDY_SELECTORS.lessonItem);
  const count = await lessonItems.count();
  let fallback = null;

  for (let index = 0; index < count; index += 1) {
    const item = lessonItems.nth(index);
    const itemId = await item.getAttribute("id").catch(() => "");
    const knowledgeId = itemId?.startsWith("cur") ? itemId.slice(3) : itemId || null;
    if (index + 1 === Number(lesson.ordinal)) {
      fallback = item;
    }
    if (String(knowledgeId ?? "") !== String(lesson.knowledgeId ?? "")) {
      continue;
    }
    fallback = item;
    break;
  }

  if (!fallback) {
    return null;
  }

  const link = fallback.locator(STUDY_SELECTORS.lessonLink).first();
  await link.waitFor({ state: "visible", timeout: timeoutMs });
  await link.click();
  await page
    .waitForURL((url) => url.pathname.includes("/mycourse/studentstudy"), { timeout: timeoutMs })
    .catch(() => null);
  return waitForCardsFrame(page, timeoutMs);
}

export async function readTaskTabs(page) {
  const locator = page.locator(STUDY_SELECTORS.taskTab);
  await locator.first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => null);
  return locator.evaluateAll((elements) => {
    const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    return elements.map((element, index) => {
      const attributes = {};
      for (const attribute of element.attributes) {
        attributes[attribute.name.toLowerCase()] = attribute.value;
      }
      return {
        tabId: element.id || null,
        ordinal: index + 1,
        title: normalizeText(element.getAttribute("title") || element.textContent) || `任务 ${index + 1}`,
        attributes,
      };
    });
  });
}

function tabsWithIdentity(tabs) {
  return tabs.map((tab) => ({ ...tab, cardId: extractCardId(tab.attributes) }));
}

export function selectTaskTabIndex(tabs, task) {
  if (task.cardId) {
    const byCard = tabs.findIndex((candidate) => candidate.cardId === task.cardId);
    if (byCard >= 0) return byCard;
  }
  if (task.tabId) {
    const byId = tabs.findIndex((candidate) => candidate.tabId === task.tabId);
    if (byId >= 0) return byId;
  }
  const byOrdinal = tabs.findIndex(
    (candidate) => Number(candidate.ordinal) === Number(task.ordinal),
  );
  return byOrdinal;
}

export async function clickTaskTab(page, task) {
  const tabs = tabsWithIdentity(await readTaskTabs(page));
  const index = selectTaskTabIndex(tabs, task);
  if (index < 0) {
    throw new Error(`未找到任务标签 ${task.title ?? task.key}。`);
  }
  const locator = page.locator(STUDY_SELECTORS.taskTab).nth(index);
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ force: true }).catch(() => locator.click());
  return tabs[index];
}

export async function findVisibleTaskSurface(page, expectedKind = null) {
  const visibleModules = [];
  for (const frame of page.frames()) {
    const type = moduleTypeForFrame(frame);
    if (type && (await frameIsVisible(frame))) {
      const hasExpectedContent =
        (type === "video" && (await frame.locator("video").count().catch(() => 0)) > 0) ||
        (type === "audio" && (await frame.locator("audio").count().catch(() => 0)) > 0) ||
        (type === "quiz" &&
          (await frame.locator(STUDY_SELECTORS.quiz.questionBlock).count().catch(() => 0)) > 0);
      const surface = { frame, moduleType: type, hasInlineQuiz: false };
      const surfaceKind = classifyTaskKind({ title: "", moduleType: type });
      if (hasExpectedContent && (!expectedKind || surfaceKind === expectedKind)) {
        return surface;
      }
      visibleModules.push(surface);
    }
  }

  // 作业帧按内容识别：章节作业可能嵌套在多层 iframe 里（如
  // /ananas/modules/work/index.html -> /mooc-ans/work/selectWorkQuestionYiPiYue），
  // 只按 URL 匹配不到最内层真正装题目的帧，因此这里扫描所有 frame 的题目块。
  for (const frame of page.frames()) {
    const question = frame.locator(STUDY_SELECTORS.quiz.questionBlock).first();
    if ((await question.count().catch(() => 0)) > 0 && (await question.isVisible().catch(() => false))) {
      if (!expectedKind || expectedKind === "assessment") {
        return { frame, moduleType: "quiz", hasInlineQuiz: false };
      }
    }
  }

  for (const frame of page.frames()) {
    const quiz = frame.locator(STUDY_SELECTORS.inlineQuiz).first();
    if ((await quiz.count().catch(() => 0)) > 0 && (await quiz.isVisible().catch(() => false))) {
      if (!expectedKind || expectedKind === "assessment") {
        return { frame, moduleType: "quiz", hasInlineQuiz: true };
      }
    }
  }
  // 嵌套模块中实际内容帧通常排在父模块之后，兜底取最深的最后一帧。
  if (expectedKind) {
    return (
      visibleModules
        .filter(
          (surface) =>
            classifyTaskKind({ title: "", moduleType: surface.moduleType }) === expectedKind,
        )
        .at(-1) ?? null
    );
  }
  return visibleModules.at(-1) ?? null;
}

export async function waitForTaskSurface(page, timeoutMs, expectedKind = null, title = "") {
  const deadline = Date.now() + timeoutMs;
  let lastSurface = null;
  let lastUrl = null;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const surface = await findVisibleTaskSurface(page, expectedKind);
    if (surface) {
      lastSurface = surface;
      const actualKind = classifyTaskKind({
        title: "",
        moduleType: surface.moduleType,
        hasInlineQuiz: surface.hasInlineQuiz,
      });
      if (!expectedKind || expectedKind === "other" || actualKind === expectedKind) {
        let url = null;
        try {
          url = surface.frame.url();
        } catch {
          url = null;
        }
        if (url && url === lastUrl) {
          stableCount += 1;
          // 帧 URL 连续多次轮询不变，说明重定向已结束，才返回，避免拿到瞬态帧。
          if (stableCount >= 2) {
            return surface;
          }
        } else {
          lastUrl = url;
          stableCount = url ? 1 : 0;
        }
      } else {
        lastUrl = null;
        stableCount = 0;
      }
    } else {
      lastUrl = null;
      stableCount = 0;
    }
    await page.waitForTimeout(200);
  }
  return lastSurface;
}

export async function discoverLessonTasks({ page, course, lesson, timeoutMs }) {
  const tabs = tabsWithIdentity(await readTaskTabs(page));
  const tasks = [];
  let surfaceFailure = null;

  if (tabs.length === 0) {
    return {
      tasks,
      surfaceFailure:
        "课节页面中未发现任务标签（li[id^=dct]），请校准 study-selectors.mjs 的 taskTab 选择器",
    };
  }

  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    const locator = page.locator(STUDY_SELECTORS.taskTab).nth(index);
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ force: true }).catch(() => locator.click());
    const titleKind = classifyTaskKind({ title: tab.title });
    const surface = await waitForTaskSurface(
      page,
      Math.min(timeoutMs, 5_000),
      titleKind === "other" ? null : titleKind,
      tab.title,
    );
    const kind = classifyTaskKind({
      title: tab.title,
      moduleType: surface?.moduleType,
      hasInlineQuiz: surface?.hasInlineQuiz,
    });
    const surfaceKind = surface
      ? classifyTaskKind({
          title: "",
          moduleType: surface.moduleType,
          hasInlineQuiz: surface.hasInlineQuiz,
        })
      : null;
    if (
      (!surface || (titleKind !== "other" && surfaceKind !== titleKind)) &&
      (kind === "video" || kind === "assessment")
    ) {
      surfaceFailure ??= `任务“${tab.title}”未加载出可见内容`;
    }
    tasks.push({
      key: makeTaskKey({
        courseId: course.courseId,
        clazzId: course.clazzId,
        knowledgeId: lesson.knowledgeId,
        cardId: tab.cardId,
        tabId: tab.tabId,
        ordinal: tab.ordinal,
      }),
      kind,
      tabId: tab.tabId,
      cardId: tab.cardId,
      ordinal: tab.ordinal,
      title: tab.title,
    });
  }

  return { tasks, surfaceFailure };
}
