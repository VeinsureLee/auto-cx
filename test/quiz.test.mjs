import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyQuestionType,
  collectQuestions,
  mapQType,
  normalizeOptionText,
  normalizeQuestionStem,
  normalizeOptionLabel,
  shouldSubmit,
} from "../src/quiz.mjs";
import { STUDY_SELECTORS } from "../src/study-selectors.mjs";

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

test("normalizes the actual Chaoxing stem content instead of only the question-type label", () => {
  assert.equal(
    normalizeQuestionStem("【单选题】创业教育被称为教育的（）。", "【单选题】"),
    "创业教育被称为教育的（）。",
  );
});

test("normalizes option text from the anchor content used by the answer page", () => {
  assert.equal(normalizeOptionLabel("A、", "“第一本护照”"), "“第一本护照”");
});

test("collectQuestions runs its text normalization inside the page evaluation context", async () => {
  const makeElement = ({ textContent = "", children = {}, lists = {} } = {}) => ({
    textContent,
    querySelector(selector) {
      return children[selector] ?? null;
    },
    querySelectorAll(selector) {
      return lists[selector] ?? [];
    },
    getAttribute() {
      return null;
    },
  });
  const marker = makeElement({ textContent: "A、" });
  const anchor = makeElement({ textContent: "“第一本护照”" });
  const item = makeElement({
    children: {
      ".num_option, i.fl": marker,
      "a.after, a": anchor,
    },
  });
  const stemContent = makeElement({ textContent: "【单选题】创业教育被称为教育的（）。" });
  const stem = makeElement({
    children: {
      ".qtContent": stemContent,
      ".newZy_TItle": makeElement({ textContent: "【单选题】" }),
      p: null,
    },
  });
  const block = makeElement({
    children: { ".Zy_TItle": stem },
    lists: { "ul.Zy_ulTop li": [item] },
  });
  const frame = {
    locator() {
      return {
        evaluateAll(callback, selectors) {
          // Simulate Playwright's isolated page context: outer Node bindings are unavailable.
          return Function("callback", "blocks", "selectors", "return (" + callback.toString() + ")(blocks, selectors);")(callback, [block], selectors);
        },
      };
    },
  };

  const [question] = await collectQuestions(frame);
  assert.equal(question.stem, "创业教育被称为教育的（）。");
  assert.deepEqual(question.options, [{ data: "", text: "“第一本护照”" }]);
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

test("videoQuiz selectors no longer define a cumulative attempt cap", () => {
  // 整段视频不再限制弹题总次数；每次弹题内的选项尝试次数由 handleVideoQuizWork 控制。
  assert.equal("maxAttempts" in STUDY_SELECTORS.videoQuiz, false);
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
