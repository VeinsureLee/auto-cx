import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrompt,
  normalizeAnswer,
  parseLlmJson,
  stripCodeFences,
} from "../src/answerer.mjs";
import { decideVideoEnded } from "../src/task-point.mjs";

test("stripCodeFences removes fenced JSON wrapper", () => {
  assert.equal(stripCodeFences('```json\n[{"a":1}]\n```'), '[{"a":1}]');
  assert.equal(stripCodeFences('```json\n[{"a":1}]\n```\n'), '[{"a":1}]');
  assert.equal(stripCodeFences('  [{"a":1}]  '), '[{"a":1}]');
  assert.equal(stripCodeFences(undefined), "");
});

test("parseLlmJson handles bare arrays and objects", () => {
  assert.deepEqual(parseLlmJson('[{"index":1}]'), [{ index: 1 }]);
  assert.deepEqual(parseLlmJson('{"index":1}'), { index: 1 });
});

test("parseLlmJson ignores leading explanatory text", () => {
  assert.deepEqual(parseLlmJson('好的，答案如下：[{"index":1,"type":"single","selectedIndexes":[2]}]'), [
    { index: 1, type: "single", selectedIndexes: [2] },
  ]);
});

test("parseLlmJson strips code fences with explanation", () => {
  assert.deepEqual(
    parseLlmJson('```json\n[{"index":2,"type":"judge","trueFalse":true}]\n```'),
    [{ index: 2, type: "judge", trueFalse: true }],
  );
});

test("parseLlmJson returns null for garbage or unbalanced input", () => {
  assert.equal(parseLlmJson("抱歉，我无法回答"), null);
  assert.equal(parseLlmJson("[{unfinished"), null);
  assert.equal(parseLlmJson(""), null);
});

test("buildPrompt includes every stem and the JSON schema keys", () => {
  const prompt = buildPrompt([
    { type: "single", stem: "以下哪项正确？", options: ["甲", "乙"] },
    { type: "judge", stem: "地球是圆的。", options: [] },
  ]);

  assert.ok(prompt.includes("以下哪项正确？"));
  assert.ok(prompt.includes("地球是圆的。"));
  assert.ok(prompt.includes("selectedIndexes"));
  assert.ok(prompt.includes("trueFalse"));
  assert.ok(prompt.includes("fillText"));
  assert.ok(prompt.includes("essayText"));
  assert.ok(prompt.includes("1. [single]"));
  assert.ok(prompt.includes("2. [judge]"));
});

test("normalizeAnswer validates and shapes each answer type", () => {
  assert.deepEqual(normalizeAnswer({ index: "1", type: "single", selectedIndexes: [1, 1, 2] }), {
    index: 1,
    type: "single",
    selectedIndexes: [1, 2],
  });
  assert.deepEqual(normalizeAnswer({ index: 3, type: "judge", trueFalse: false }), {
    index: 3,
    type: "judge",
    trueFalse: false,
  });
  assert.deepEqual(normalizeAnswer({ index: 2, type: "fill", fillText: " 答案 " }), {
    index: 2,
    type: "fill",
    fillText: "答案",
  });
  assert.equal(normalizeAnswer({ index: 1, type: "single", selectedIndexes: [] }), null);
  assert.equal(normalizeAnswer({ index: "abc", type: "judge", trueFalse: true }), null);
  assert.equal(normalizeAnswer({ index: 1, type: "unknown" }), null);
});

test("buildPrompt renders both string and object-style options", () => {
  const prompt = buildPrompt([
    { type: "single", stem: "单选题题干", options: [{ data: "A", text: "选项甲" }, { data: "B", text: "选项乙" }] },
    { type: "judge", stem: "判断题题干", options: [{ data: "true", text: "对" }, { data: "false", text: "错" }] },
  ]);

  assert.ok(prompt.includes("1. 选项甲"));
  assert.ok(prompt.includes("2. 选项乙"));
  assert.ok(prompt.includes("1. 对"));
  assert.ok(prompt.includes("2. 错"));
  assert.ok(!prompt.includes("[object Object]"));
});

test("decideVideoEnded treats ended or near-duration as finished", () => {
  assert.equal(decideVideoEnded({ ended: true, currentTime: 10, duration: 10 }), true);
  assert.equal(decideVideoEnded({ ended: false, currentTime: 9.6, duration: 10 }), true);
  assert.equal(decideVideoEnded({ ended: false, currentTime: 9.4, duration: 10 }), false);
  assert.equal(decideVideoEnded({ ended: false, currentTime: 5, duration: null }), false);
  assert.equal(decideVideoEnded(null), false);
});