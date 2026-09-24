import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyQuestionType,
  mapQType,
  normalizeOptionText,
  shouldSubmit,
} from "../src/quiz.mjs";

test("mapQType maps Chaoxing question type codes", () => {
  assert.equal(mapQType("0"), "single");
  assert.equal(mapQType(1), "multi");
  assert.equal(mapQType(2), "fill");
  assert.equal(mapQType(3), "judge");
  assert.equal(mapQType(4), "essay");
  assert.equal(mapQType(9), null);
  assert.equal(mapQType("abc"), null);
  assert.equal(mapQType(null), null);
  assert.equal(mapQType(""), null);
});

test("normalizeOptionText strips the leading option marker", () => {
  assert.equal(normalizeOptionText("A. 创新"), "创新");
  assert.equal(normalizeOptionText("B、创业"), "创业");
  assert.equal(normalizeOptionText("C) 风险"), "风险");
  assert.equal(normalizeOptionText(" 创新 "), "创新");
  assert.equal(normalizeOptionText("对"), "对");
});

test("classifyQuestionType detects multi from checkboxes", () => {
  assert.equal(
    classifyQuestionType({ checkboxCount: 2 }),
    "multi",
  );
});

test("classifyQuestionType detects single from radios", () => {
  assert.equal(
    classifyQuestionType({ radioCount: 4, optionCount: 4 }),
    "single",
  );
});

test("classifyQuestionType detects judge from 对/错 options or stem", () => {
  assert.equal(
    classifyQuestionType({
      radioCount: 2,
      optionCount: 2,
      stemNotes: "请判断下面说法是否正确：……约等于…",
    }),
    "judge",
  );
  assert.equal(
    classifyQuestionType({ optionCount: 2, stemNotes: "这是判断题" }),
    "judge",
  );
});

test("classifyQuestionType detects essay from textarea", () => {
  assert.equal(classifyQuestionType({ textareaCount: 1 }), "essay");
});

test("classifyQuestionType detects fill from free inputs", () => {
  assert.equal(classifyQuestionType({ inputCount: 2 }), "fill");
});

test("classifyQuestionType falls back to other for unrecognized blocks", () => {
  assert.equal(classifyQuestionType({}), "other");
});

test("shouldSubmit only allows submission when every question has a valid answer", () => {
  const questions = [
    { type: "single", index: 1, options: ["A", "B"] },
    { type: "judge", index: 2 },
  ];
  const allAnswered = [
    { index: 1, selectedIndexes: [2] },
    { index: 2, trueFalse: true },
  ];
  const missingOne = [
    { index: 1, selectedIndexes: [2] },
  ];
  const hasOtherType = [
    { type: "other", index: 3 },
  ];

  assert.equal(shouldSubmit(questions, allAnswered), true);
  assert.equal(shouldSubmit(questions, missingOne), false);
  assert.equal(shouldSubmit(hasOtherType, allAnswered), false);
  assert.equal(shouldSubmit([], []), false);
  assert.equal(shouldSubmit(questions, []), false);
  assert.equal(
    shouldSubmit(questions, [
      { index: 1, selectedIndexes: [3] },
      { index: 2, trueFalse: true },
    ]),
    false,
  );
});
