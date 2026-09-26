import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { readConfig } from "./config.mjs";
import { escapeMarkdownCell } from "./course-progress.mjs";
import { runStudy } from "./study.mjs";

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href;

export function renderStudyReportMarkdown(report) {
  const mode = report.requestedPhase === "video"
    ? "仅视频阶段（不处理章节作业）"
    : report.requestedPhase === "homework"
      ? "仅作业阶段（不播放视频）"
      : report.dryRun
        ? "演练（dry-run，章节作业只填答不提交）"
        : "全自动（作答并提交）";
  const lines = [
    "# 超星自动学习报告",
    "",
    `更新时间：${report.generatedAt}`,
    `模式：${mode}`,
    ...(report.fatalError ? [`致命错误：${report.fatalError}`] : []),
    "",
  ];

  for (const course of report.courses) {
    lines.push(`## ${course.name}`, "");
    lines.push("| 课节 | 状态 | 视频 | 作业 | 备注 |", "| --- | --- | --- | --- | --- |");
    for (const lesson of course.lessons) {
      lines.push(
        `| ${escapeMarkdownCell(lesson.title)} | ${escapeMarkdownCell(lesson.status)} | ${escapeMarkdownCell(lesson.video?.status)} | ${escapeMarkdownCell(lesson.homework?.status)} | ${escapeMarkdownCell(lesson.detail)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function collectCourseArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--course") {
      const chunk = argv[index + 1];
      if (chunk) {
        values.push(...chunk.split(",").map((item) => item.trim()).filter(Boolean));
      }
      index += 1;
    }
  }
  return values;
}

function collectLessonArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--lesson") {
      const chunk = argv[index + 1];
      if (chunk) {
        values.push(chunk.trim());
      }
      index += 1;
    }
  }
  return values;
}

export function collectPhaseArg(argv) {
  const indexes = argv
    .map((value, index) => (value === "--phase" ? index : -1))
    .filter((index) => index >= 0);
  if (!indexes.length) {
    return null;
  }
  if (indexes.length > 1) {
    throw new Error("--phase 只能指定一次。");
  }
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--phase 需要一个值；目前支持 video。");
  }
  if (!["video", "homework"].includes(value)) {
    throw new Error(`不支持的 --phase 值“${value}”；目前支持 video 或 homework。`);
  }
  return value;
}

export async function writeStudyReport(report, config) {
  await mkdir(path.dirname(config.studyReportPath), { recursive: true });
  await mkdir(path.dirname(config.studyReportMarkdownPath), { recursive: true });
  await writeFile(config.studyReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    config.studyReportMarkdownPath,
    renderStudyReportMarkdown(report),
    "utf8",
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const courseArgs = collectCourseArgs(process.argv);
  const lessonArgs = collectLessonArgs(process.argv);
  const phase = collectPhaseArg(process.argv);
  const config = readConfig(process.env, process.cwd(), { requireCredentials: false });
  const coursesQuery = courseArgs.length ? courseArgs : config.studyCourses;
  const lessonsQuery = lessonArgs.length ? lessonArgs : null;

  if (coursesQuery.length) {
    console.log(`指定课程：${coursesQuery.join("、")}`);
  }
  if (lessonsQuery?.length) {
    console.log(`指定节号：${lessonsQuery.join("、")}`);
  }
  console.log(
    phase === "video"
      ? "自动学习（仅视频阶段）：自然播放并记录断点，不处理章节作业。"
      : phase === "homework"
        ? "自动学习（仅作业阶段）：只作答并提交章节作业，不播放视频。"
        : dryRun
          ? "自动学习（演练模式）：视频照常播放；章节作业只填入答案，不提交。"
          : "自动学习（全自动模式）：逐课节看完视频，再做该课节作业。",
  );

  const report = await runStudy({ dryRun, phase, config, coursesQuery, lessonsQuery });
  await writeStudyReport(report, config);

  for (const course of report.courses) {
    console.log(`- ${course.name}`);
    for (const lesson of course.lessons) {
      console.log(
        `  [${lesson.status}] ${lesson.title}（视频 ${lesson.video?.status ?? "—"} / 作业 ${lesson.homework?.status ?? "—"}）${lesson.detail ? ` — ${lesson.detail}` : ""}`,
      );
    }
  }

  console.log(`报告已保存到 ${path.relative(process.cwd(), config.studyReportPath)}。`);
  console.log(`Markdown 报告已保存到 ${path.relative(process.cwd(), config.studyReportMarkdownPath)}。`);
}

if (IS_MAIN) {
  main().catch(async (error) => {
    if (error.studyReport) {
      try {
        const config = readConfig(process.env, process.cwd(), { requireCredentials: false });
        await writeStudyReport(error.studyReport, config);
        console.error("失败现场已写入学习报告。");
      } catch (reportError) {
        console.error(`失败报告写入失败：${reportError.message}`);
      }
    }
    console.error(`自动学习未完成：${error.message}`);
    process.exitCode = 1;
  });
}
