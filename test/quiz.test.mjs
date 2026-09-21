import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyQuestionType,
  normalizeOptionText,
  shouldSubmit,
} from "../src/quiz.mjs";

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
    { type: "single", index: 1 },
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
});