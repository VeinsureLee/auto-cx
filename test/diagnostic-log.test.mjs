import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendAnswerDiagnostics } from "../src/persistence/diagnostic-log.mjs";

test("appendAnswerDiagnostics creates the file, appends, and stays quiet on bad paths", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "answer-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "nested", "answers.log");

  assert.equal(await appendAnswerDiagnostics(filePath, ["第一行", "  第二行"]), true);
  assert.equal(await appendAnswerDiagnostics(filePath, ["第三行"]), true);
  assert.equal(await readFile(filePath, "utf8"), "第一行\n  第二行\n第三行\n");

  // 缺路径或空内容时直接跳过，不能因为写不出诊断而打断学习流程。
  assert.equal(await appendAnswerDiagnostics(undefined, ["x"]), false);
  assert.equal(await appendAnswerDiagnostics(filePath, []), false);
  assert.equal(await appendAnswerDiagnostics(filePath, null), false);
  assert.equal(await readFile(filePath, "utf8"), "第一行\n  第二行\n第三行\n");
});
