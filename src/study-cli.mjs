import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { readConfig } from "./config.mjs";
import { escapeMarkdownCell } from "./course-progress.mjs";
import { runStudy } from "./study.mjs";

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href;

export function renderStudyReportMarkdown(report) {
  const lines = [
    "# 超星自动学习报告",
    "",
    `更新时间：${report.generatedAt}`,
    `模式：${report.dryRun ? "演练（dry-run，只作答不提交）" : "全自动（作答并提交）"}`,
    "",
  ];

  for (const course of report.courses) {
    lines.push(`## ${course.name}`, "");
    lines.push("| 课节 | 状态 | 任务点 | 备注 |", "| --- | --- | --- | --- |");

    for (const lesson of course.lessons) {
      const taskPointText = lesson.taskPoints.length
        ? lesson.taskPoints
            .map(
              (taskPoint) =>
                `${taskPoint.type}:${taskPoint.status}${taskPoint.detail ? `(${taskPoint.detail})` : ""}`,
            )
            .join("; ")
        : "—";
      lines.push(
        `| ${escapeMarkdownCell(lesson.title)} | ${escapeMarkdownCell(lesson.status)} | ${escapeMarkdownCell(taskPointText)} | ${escapeMarkdownCell(lesson.detail)} |`,
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const courseArgs = collectCourseArgs(process.argv);
  const config = readConfig(process.env, process.cwd(), { requireCredentials: false });
  const coursesQuery = courseArgs.length ? courseArgs : config.studyCourses;

  if (coursesQuery.length) {
    console.log(`指定课程：${coursesQuery.join("、")}`);
  }
  console.log(
    dryRun
      ? "自动学习（演练模式）：仅作答并填入答案，不会提交。"
      : "自动学习（全自动模式）：作答并提交答案。",
  );

  const report = await runStudy({ dryRun, config, coursesQuery });
  await mkdir(path.dirname(config.studyReportPath), { recursive: true });
  await mkdir(path.dirname(config.studyReportMarkdownPath), { recursive: true });
  await writeFile(config.studyReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    config.studyReportMarkdownPath,
    renderStudyReportMarkdown(report),
    "utf8",
  );

  for (const course of report.courses) {
    console.log(`- ${course.name}`);
    for (const lesson of course.lessons) {
      if (lesson.status === "skipped") {
        continue;
      }
      console.log(`  [${lesson.status}] ${lesson.title} — ${lesson.detail ?? ""}`);
    }
  }

  console.log(`报告已保存到 ${path.relative(process.cwd(), config.studyReportPath)}。`);
  console.log(`Markdown 报告已保存到 ${path.relative(process.cwd(), config.studyReportMarkdownPath)}。`);
}

if (IS_MAIN) {
  main().catch((error) => {
    console.error(`自动学习未完成：${error.message}`);
    process.exitCode = 1;
  });
}