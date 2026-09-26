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
