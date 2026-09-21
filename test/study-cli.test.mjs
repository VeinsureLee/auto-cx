import assert from "node:assert/strict";
import test from "node:test";

import { renderStudyReportMarkdown } from "../src/study-cli.mjs";

const sampleReport = {
  dryRun: true,
  generatedAt: "2026-09-21T00:00:00.000Z",
  courses: [
    {
      courseId: "1",
      name: "创新创业基础",
      lessons: [
        {
          title: "1.1 创新目标",
          status: "completed",
          detail: "已推进到下一课节",
          taskPoints: [
            { type: "video", status: "watched" },
            { type: "quiz", status: "dry-run", detail: "已填入 2/2 题答案，未提交" },
          ],
        },
        {
          title: "1.2 被锁定",
          status: "skipped",
          detail: "被“闯关”锁定",
          taskPoints: [],
        },
      ],
    },
  ],
};

test("renderStudyReportMarkdown renders a readable per-lesson table", () => {
  const output = renderStudyReportMarkdown(sampleReport);

  assert.ok(output.includes("# 超星自动学习报告"));
  assert.ok(output.includes("演练（dry-run，只作答不提交）"));
  assert.ok(output.includes("## 创新创业基础"));
  assert.ok(output.includes("1.1 创新目标"));
  assert.ok(output.includes("video:watched"));
  assert.ok(output.includes("quiz:dry-run(已填入 2/2 题答案，未提交)"));
  assert.ok(output.includes("1.2 被锁定"));
});

test("renderStudyReportMarkdown escapes pipes inside cells", () => {
  const withPipe = {
    dryRun: false,
    generatedAt: "2026-09-21T00:00:00.000Z",
    courses: [
      {
        courseId: "1",
        name: "课程",
        lessons: [{ title: "含|竖线", status: "error", detail: "错误|说明", taskPoints: [] }],
      },
    ],
  };
  const output = renderStudyReportMarkdown(withPipe);
  assert.ok(output.includes("含\\|竖线"));
  assert.ok(output.includes("错误\\|说明"));
});