import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { escapeMarkdownCell } from "./course-progress.mjs";

export const STUDY_MEMO_SCHEMA_VERSION = 1;

export const VIDEO_STATUSES = new Set([
  "pending",
  "done",
  "blocked",
  "failed",
  "none",
]);

export const HOMEWORK_STATUSES = new Set([
  "pending",
  "submitted",
  "dry_run",
  "blocked",
  "failed",
  "uncertain",
  "none",
]);

function timestamp(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function normalizeQueries(queries) {
  return (queries ?? []).map((query) => String(query).trim()).filter(Boolean);
}

export function makeCourseKey(course) {
  return `${course.courseId ?? ""}:${course.clazzId ?? ""}`;
}

function initialVideo() {
  return { status: "pending", lastError: null, updatedAt: null };
}

function initialHomework() {
  return { status: "pending", lastError: null, updatedAt: null };
}

function createCourseRecord(course) {
  return {
    courseId: String(course.courseId ?? ""),
    clazzId: String(course.clazzId ?? ""),
    name: String(course.name ?? ""),
    url: String(course.url ?? ""),
    lessons: [],
  };
}

export function createStudyMemo({
  courses = [],
  courseQueries = [],
  now = () => new Date(),
} = {}) {
  const createdAt = timestamp(now);
  return {
    schemaVersion: STUDY_MEMO_SCHEMA_VERSION,
    createdAt,
    updatedAt: createdAt,
    selection: { courseQueries: normalizeQueries(courseQueries) },
    courses: courses.map(createCourseRecord),
  };
}

export function validateStudyMemo(memo) {
  if (!memo || typeof memo !== "object" || Array.isArray(memo)) {
    throw new Error("学习备忘录不是有效的 JSON 对象。");
  }
  if (memo.schemaVersion !== STUDY_MEMO_SCHEMA_VERSION) {
    throw new Error(
      `不支持的学习备忘录版本 ${memo.schemaVersion ?? "<缺失>"}；当前仅支持版本 ${STUDY_MEMO_SCHEMA_VERSION}。`,
    );
  }
  if (!Array.isArray(memo.courses)) {
    throw new Error("学习备忘录缺少 courses 数组。");
  }
  if (!memo.selection || !Array.isArray(memo.selection.courseQueries)) {
    throw new Error("学习备忘录缺少 selection.courseQueries 数组。");
  }
  for (const course of memo.courses) {
    if (!Array.isArray(course.lessons)) {
      throw new Error(`课程 ${course.courseId ?? "<未知>"} 的 lessons 不是数组。`);
    }
    for (const lesson of course.lessons) {
      if (lesson.video && !VIDEO_STATUSES.has(lesson.video.status)) {
        throw new Error(`课节 ${lesson.knowledgeId ?? "<未知>"} 的视频状态无效。`);
      }
      if (lesson.homework && !HOMEWORK_STATUSES.has(lesson.homework.status)) {
        throw new Error(`课节 ${lesson.knowledgeId ?? "<未知>"} 的作业状态无效。`);
      }
    }
  }
  return memo;
}

export function prepareMemoForSelection(
  memo,
  { courses = [], courseQueries = [], now = () => new Date() } = {},
) {
  validateStudyMemo(memo);
  memo.selection = { courseQueries: normalizeQueries(courseQueries) };

  for (const course of courses) {
    const identity = makeCourseKey(course);
    const record = memo.courses.find((candidate) => makeCourseKey(candidate) === identity);
    if (!record) {
      memo.courses.push(createCourseRecord(course));
    } else {
      record.name = String(course.name ?? record.name ?? "");
      record.url = String(course.url ?? record.url ?? "");
      record.lessons ??= [];
    }
  }

  memo.updatedAt = timestamp(now);
  return memo;
}

function findCourseRecord(memo, course) {
  return memo.courses.find((candidate) => makeCourseKey(candidate) === makeCourseKey(course));
}

function findLessonRecord(courseRecord, lesson) {
  const knowledgeId = lesson.knowledgeId == null ? null : String(lesson.knowledgeId);
  return courseRecord.lessons.find((candidate) =>
    knowledgeId
      ? String(candidate.knowledgeId ?? "") === knowledgeId
      : candidate.knowledgeId == null &&
        Number(candidate.ordinal ?? 0) === Number(lesson.ordinal ?? 0),
  );
}

function catalogFields(lesson) {
  return {
    title: String(lesson.title ?? ""),
    section: lesson.section == null ? null : String(lesson.section),
    ordinal: lesson.ordinal == null ? null : Number(lesson.ordinal),
    locked: Boolean(lesson.locked),
    catalogCompleted: Boolean(lesson.catalogCompleted),
    pendingTaskCount: lesson.pendingTaskCount == null ? null : Number(lesson.pendingTaskCount),
  };
}

export function refreshCatalog(memo, course, lessons, now = () => new Date()) {
  prepareMemoForSelection(memo, {
    courses: [course],
    courseQueries: memo.selection.courseQueries,
    now,
  });
  const record = findCourseRecord(memo, course);

  for (const lesson of lessons) {
    if (lesson.knowledgeId == null) {
      continue;
    }
    const knowledgeId = String(lesson.knowledgeId);
    const existing = record.lessons.find(
      (candidate) => String(candidate.knowledgeId ?? "") === knowledgeId,
    );
    if (existing) {
      Object.assign(existing, catalogFields(lesson));
    } else {
      record.lessons.push({
        knowledgeId,
        ...catalogFields(lesson),
        video: initialVideo(),
        homework: initialHomework(),
      });
    }
  }

  record.lessons.sort((left, right) => Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0));
  memo.updatedAt = timestamp(now);
  return record;
}

export function setLessonVideo(memo, course, lesson, patch, now = () => new Date()) {
  const record = findCourseRecord(memo, course);
  if (!record) {
    throw new Error(`备忘录中不存在课程 ${course.courseId ?? ""}。`);
  }
  const target = findLessonRecord(record, lesson);
  if (!target) {
    throw new Error(`备忘录中不存在课节 ${lesson.knowledgeId ?? lesson.title ?? ""}。`);
  }
  target.video = { ...initialVideo(), ...target.video, ...patch, updatedAt: timestamp(now) };
  memo.updatedAt = timestamp(now);
  return target;
}

export function setLessonHomework(memo, course, lesson, patch, now = () => new Date()) {
  const record = findCourseRecord(memo, course);
  if (!record) {
    throw new Error(`备忘录中不存在课程 ${course.courseId ?? ""}。`);
  }
  const target = findLessonRecord(record, lesson);
  if (!target) {
    throw new Error(`备忘录中不存在课节 ${lesson.knowledgeId ?? lesson.title ?? ""}。`);
  }
  target.homework = {
    ...initialHomework(),
    ...target.homework,
    ...patch,
    updatedAt: timestamp(now),
  };
  memo.updatedAt = timestamp(now);
  return target;
}

export function videoNeedsWork(video) {
  return ["pending", "blocked", "failed"].includes(video?.status);
}

export function homeworkNeedsWork(homework, { submitDryRun = false } = {}) {
  const statuses = submitDryRun
    ? ["pending", "blocked", "failed", "uncertain", "dry_run"]
    : ["pending", "blocked", "failed", "uncertain"];
  return statuses.includes(homework?.status);
}

export function lessonNeedsVideo(lesson) {
  return !lesson.catalogCompleted && videoNeedsWork(lesson.video);
}

export function lessonNeedsHomework(lesson, { submitDryRun = false } = {}) {
  return !lesson.catalogCompleted && homeworkNeedsWork(lesson.homework, { submitDryRun });
}

export function lessonNeedsWork(lesson, { phase = null, submitDryRun = false } = {}) {
  const video = phase === "homework" ? false : lessonNeedsVideo(lesson);
  const homework = phase === "video" ? false : lessonNeedsHomework(lesson, { submitDryRun });
  return { video, homework, any: video || homework };
}

export function lessonStatusLabel(lesson) {
  if (lesson.catalogCompleted) {
    return "completed";
  }
  if (lesson.locked) {
    return "locked";
  }
  const video = lessonNeedsVideo(lesson);
  const homework = lessonNeedsHomework(lesson);
  if (!video && !homework) {
    return "done";
  }
  if (lesson.video?.status === "blocked" || lesson.homework?.status === "blocked") {
    return "blocked";
  }
  if (lesson.video?.status === "failed" || lesson.homework?.status === "failed") {
    return "failed";
  }
  return "pending";
}

export async function readStudyMemo(filePath) {
  try {
    const contents = await readFile(filePath, "utf8");
    return validateStudyMemo(JSON.parse(contents));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`学习备忘录 ${filePath} 不是有效 JSON：${error.message}`);
    }
    throw error;
  }
}

export async function atomicWriteFile(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function renderStudyMemoMarkdown(memo) {
  const lines = [
    "# 超星学习备忘录",
    "",
    `更新时间：${memo.updatedAt}`,
    "",
  ];

  for (const course of memo.courses) {
    lines.push(`## ${course.name}`, "", "| 课节 | 视频 | 作业 | 备注 |", "| --- | --- | --- | --- |");
    for (const lesson of course.lessons ?? []) {
      const video = lesson.video?.status ?? "—";
      const homework = lesson.homework?.status ?? "—";
      const detail = [
        lesson.catalogCompleted ? "目录已完成" : "",
        lesson.locked ? "闯关锁定" : "",
        lesson.homework?.lastAnswers?.length ? `已存答案 ${lesson.homework.lastAnswers.length} 题` : "",
        lesson.homework?.trials?.length ? `试错 ${lesson.homework.trials.length} 次` : "",
        lesson.video?.lastError ? `视频：${lesson.video.lastError}` : "",
        lesson.homework?.lastError ? `作业：${lesson.homework.lastError}` : "",
      ]
        .filter(Boolean)
        .join("；");
      lines.push(
        `| ${escapeMarkdownCell(lesson.title)} | ${escapeMarkdownCell(video)} | ${escapeMarkdownCell(homework)} | ${escapeMarkdownCell(detail)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export class StudyMemoStore {
  constructor({ filePath, markdownPath, state, now = () => new Date() }) {
    this.filePath = filePath;
    this.markdownPath = markdownPath;
    this.state = state;
    this.now = now;
    this.mutationQueue = Promise.resolve();
  }

  static async open({
    filePath,
    markdownPath,
    courses = [],
    courseQueries = [],
    now = () => new Date(),
  }) {
    if (markdownPath && path.resolve(filePath) === path.resolve(markdownPath)) {
      throw new Error("学习备忘录 JSON 与 Markdown 路径不能相同。");
    }
    const loaded = await readStudyMemo(filePath);
    const state = loaded ?? createStudyMemo({ courses, courseQueries, now });
    prepareMemoForSelection(state, { courses, courseQueries, now });
    const store = new StudyMemoStore({ filePath, markdownPath, state, now });
    await store.save();
    return store;
  }

  async save() {
    this.state.updatedAt = timestamp(this.now);
    await atomicWriteFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
    if (this.markdownPath) {
      await atomicWriteFile(this.markdownPath, renderStudyMemoMarkdown(this.state));
    }
    return this.state;
  }

  mutate(updater) {
    const operation = this.mutationQueue.then(async () => {
      const result = await updater(this.state);
      await this.save();
      return result;
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }
}
