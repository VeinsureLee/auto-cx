import assert from "node:assert/strict";
import test from "node:test";

import {
  collectConcurrencyArg,
  collectPhaseArg,
  renderStudyReportMarkdown,
} from "../src/study-cli.mjs";

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
          status: "done",
          detail: null,
          video: { status: "done", lastError: null },
          homework: { status: "dry_run", lastError: null },
        },
        {
          title: "1.2 被锁定",
          status: "locked",
          detail: "被闯关锁定",
          video: { status: "pending", lastError: null },
          homework: { status: "pending", lastError: null },
        },
      ],
    },
  ],
};

test("renderStudyReportMarkdown renders a readable per-lesson table", () => {
  const output = renderStudyReportMarkdown(sampleReport);

  assert.ok(output.includes("# 超星自动学习报告"));
  assert.ok(output.includes("演练（dry-run，章节作业只填答不提交）"));
  assert.ok(output.includes("## 创新创业基础"));
  assert.ok(output.includes("1.1 创新目标"));
  assert.ok(output.includes("done"));
  assert.ok(output.includes("dry_run"));
  assert.ok(output.includes("1.2 被锁定"));
  assert.ok(output.includes("被闯关锁定"));
});

test("collectPhaseArg accepts only video or homework phases", () => {
  assert.equal(collectPhaseArg(["node", "study-cli.mjs"]), null);
  assert.equal(collectPhaseArg(["node", "study-cli.mjs", "--phase", "video"]), "video");
  assert.equal(collectPhaseArg(["node", "study-cli.mjs", "--phase", "homework"]), "homework");
  assert.throws(() => collectPhaseArg(["--phase"]), /需要一个值/);
  assert.throws(() => collectPhaseArg(["--phase", "assessment"]), /目前支持 video 或 homework/);
  assert.throws(
    () => collectPhaseArg(["--phase", "video", "--phase", "video"]),
    /只能指定一次/,
  );
});

test("collectConcurrencyArg uses the configured fallback and accepts one through three", () => {
  assert.equal(collectConcurrencyArg(["node", "study-cli.mjs"], 1), 1);
  assert.equal(collectConcurrencyArg(["--concurrency", "1"], 3), 1);
  assert.equal(collectConcurrencyArg(["--concurrency", "3"], 1), 3);
});

test("collectConcurrencyArg rejects missing, repeated, and invalid values", () => {
  assert.throws(() => collectConcurrencyArg(["--concurrency"], 1), /需要一个值/);
  assert.throws(() => collectConcurrencyArg(["--concurrency", "2.5"], 1), /1 到 3/);
  assert.throws(() => collectConcurrencyArg(["--concurrency", "4"], 1), /1 到 3/);
  assert.throws(
    () => collectConcurrencyArg(["--concurrency", "2", "--concurrency", "3"], 1),
    /只能指定一次/,
  );
});

test("renderStudyReportMarkdown escapes pipes inside cells", () => {
  const withPipe = {
    dryRun: false,
    generatedAt: "2026-09-21T00:00:00.000Z",
    courses: [
      {
        courseId: "1",
        name: "课程",
        lessons: [
          {
            title: "含|竖线",
            status: "failed",
            detail: "错误|说明",
            video: { status: "failed", lastError: "错|误" },
            homework: { status: "pending", lastError: null },
          },
        ],
      },
    ],
  };
  const output = renderStudyReportMarkdown(withPipe);
  assert.ok(output.includes("含\\|竖线"));
  assert.ok(output.includes("错误\\|说明"));
});
