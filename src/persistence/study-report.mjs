import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { escapeMarkdownCell } from "./progress-format.mjs";

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

