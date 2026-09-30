import assert from "node:assert/strict";
import test from "node:test";

import {
  answerQuestions,
  buildPrompt,
  normalizeAnswer,
  parseLlmJson,
  stripCodeFences,
} from "../src/answerer.mjs";
import { parseQuestionBank } from "../src/assessment/question-bank.mjs";
import { handleQuizWork } from "../src/quiz.mjs";
import { STUDY_SELECTORS } from "../src/study-selectors.mjs";
import { decideVideoEnded } from "../src/task-point.mjs";

const BANK_TEXT = [
  "四题作业已完成本次成绩：100",
  "1",
  "【单选题】甲题？",
  "A、甲",
  "B、乙",
  "我的答案：A得分： 25.0分",
  "2",
  "【单选题】乙题？",
  "A、甲",
  "B、乙",
  "我的答案：B得分： 25.0分",
  "3",
  "【单选题】丙题？",
  "A、甲",
  "B、乙",
  "我的答案：A得分： 25.0分",
  "4",
  "【判断题】丁题。",
  "我的答案：√得分： 25.0分",
].join("\r\n");

// 题库判错的作业：第 1 题得 0 分，第 2 题满分。
const WRONG_BANK_TEXT = [
  "错题作业已完成本次成绩：50",
  "1",
  "【判断题】戊题。",
  "我的答案：√得分： 0.0分",
  "2",
  "【判断题】己题。",
  "我的答案：√得分： 50.0分",
].join("\r\n");

function bankEntries(text = BANK_TEXT) {
  return parseQuestionBank(text).entries;
}

const testConfig = () => ({
  deepseekApiKey: "test-key",
  llmModel: "deepseek-chat",
  llmBaseUrl: "https://api.deepseek.com",
});

const question = (type, stem, texts) => ({
  type,
  stem,
  options: texts.map((text) => ({ text })),
});

// 第 1、4 题在题库里，第 2、3 题不在 —— 未命中集合刻意非连续，
// 这样任何「下标加偏移」式的重映射都会露馅。
const questionsWithTwoMisses = () => [
  question("single", "甲题？", ["甲", "乙"]),
  question("single", "未收录的一题？", ["甲", "乙"]),
  question("single", "也未收录的一题？", ["甲", "乙"]),
  question("judge", "丁题。", ["对", "错"]),
];

function stubFetch(t, responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push({ url, prompt: body.messages.at(-1).content });
    return responder(calls.length, body);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const okResponse = (content) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
});

// handleQuizWork 只用到 locator 链；dry-run 分支在扫描提交按钮之前就返回，
// 因此桩出 evaluateAll、选项点击链和「暂时保存」按钮即可。
function makeFrame(questions, { saveButton = true, onClick = () => {} } = {}) {
  const option = {
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {},
    count: async () => 4,
    nth: () => option,
    textContent: async () => "",
    locator: () => ({
      count: async () => 4,
      nth: () => option,
      getAttribute: async () => null,
      textContent: async () => "",
    }),
  };
  const blocks = {
    first: () => ({ waitFor: async () => {} }),
    evaluateAll: async () => questions,
    nth: () => option,
    count: async () => 0, // 桩里没有提交按钮
  };
  const save = {
    count: async () => (saveButton ? 1 : 0),
    nth: () => ({
      isVisible: async () => true,
      click: async () => onClick(),
    }),
  };
  return {
    locator: (selector) => (selector === STUDY_SELECTORS.quiz.saveButton ? save : blocks),
    waitForTimeout: async () => {},
  };
}

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

test("buildPrompt lists tried answers so the model avoids them", () => {
  const prompt = buildPrompt(
    [{ type: "single", stem: "题干", options: ["甲", "乙"] }],
    [
      [{ index: 1, type: "single", selectedIndexes: [1] }],
      [{ index: 1, type: "single", selectedIndexes: [2] }],
    ],
  );

  assert.ok(prompt.includes("错误的答案组合"));
  assert.ok(prompt.includes("错误尝试 1"));
  assert.ok(prompt.includes("错误尝试 2"));
  assert.ok(prompt.includes('"selectedIndexes":[1]'));
  assert.ok(prompt.includes('"selectedIndexes":[2]'));
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

test("题库全部命中时不调用模型", async (t) => {
  const calls = stubFetch(t, () => {
    throw new Error("题库已覆盖全部题目，不应该发起请求");
  });

  const result = await answerQuestions(
    [question("single", "甲题？", ["甲", "乙"]), question("judge", "丁题。", ["对", "错"])],
    testConfig(),
    { questionBank: bankEntries() },
  );

  assert.equal(calls.length, 0);
  assert.equal(result.partial, false);
  assert.deepEqual(result.answers, [
    { index: 1, type: "single", selectedIndexes: [1] },
    { index: 2, type: "judge", trueFalse: true },
  ]);
  assert.match(result.note, /题库命中 2\/2 题/);
});

test("未命中的题目按原始题号下发模型并映射回来", async (t) => {
  const calls = stubFetch(t, () =>
    okResponse(
      JSON.stringify([
        { index: 1, type: "single", selectedIndexes: [2] },
        { index: 2, type: "multi", selectedIndexes: [1, 2] },
      ]),
    ),
  );

  const result = await answerQuestions(questionsWithTwoMisses(), testConfig(), {
    questionBank: bankEntries(),
  });

  assert.equal(calls.length, 1);
  // prompt 里只出现未命中的两题，且被重新编号为 1、2。
  assert.ok(calls[0].prompt.includes("未收录的一题？"));
  assert.ok(calls[0].prompt.includes("也未收录的一题？"));
  assert.ok(!calls[0].prompt.includes("甲题？"));
  assert.ok(!calls[0].prompt.includes("丁题。"));

  // 模型返回的是子集编号，最终答案必须落在原始题号 2、3 上。
  assert.deepEqual(
    result.answers.map((answer) => answer.index),
    [1, 2, 3, 4],
  );
  assert.deepEqual(result.answers[1], { index: 2, type: "single", selectedIndexes: [2] });
  assert.deepEqual(result.answers[2], { index: 3, type: "multi", selectedIndexes: [1, 2] });
  assert.equal(result.partial, false);
});

test("试错表按子集重映射，引用子集外题目的条目被丢弃", async (t) => {
  const calls = stubFetch(t, () =>
    okResponse(
      JSON.stringify([
        { index: 1, type: "single", selectedIndexes: [2] },
        { index: 2, type: "single", selectedIndexes: [2] },
      ]),
    ),
  );

  // 第 1 题会被题库答掉，它的试错记录不该出现在 prompt 里；
  // 第 3 题在子集里排第 2，它的试错记录要跟着变成 index 2。
  // 注意第 1 题的试错答案要区别于题库答案，否则会触发「题库答案已被平台判错」的降级。
  const trials = [
    [{ index: 1, type: "single", selectedIndexes: [2] }],
    [{ index: 3, type: "single", selectedIndexes: [1] }],
  ];
  const snapshot = structuredClone(trials);

  await answerQuestions(questionsWithTwoMisses(), testConfig(), {
    questionBank: bankEntries(),
    trials,
  });

  assert.ok(calls[0].prompt.includes('"index":2,"type":"single","selectedIndexes":[1]'));
  assert.ok(!calls[0].prompt.includes('"index":1,"type":"single","selectedIndexes":[2]'));
  assert.ok(!calls[0].prompt.includes('"index":3'));
  // 传进去的试错表不能被就地改写，否则会污染写回备忘录的记录。
  assert.deepEqual(trials, snapshot);
});

test("题库判定错误的答案作为排除项进入 prompt，但不写回试错表", async (t) => {
  const calls = stubFetch(t, () =>
    okResponse(JSON.stringify([{ index: 1, type: "judge", trueFalse: false }])),
  );
  const trials = [];

  await answerQuestions(
    [question("judge", "戊题。", ["对", "错"]), question("judge", "己题。", ["对", "错"])],
    testConfig(),
    { questionBank: bankEntries(WRONG_BANK_TEXT), trials },
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes("题库曾作答该题得 0 分，已确认错误"));
  assert.ok(calls[0].prompt.includes("错误尝试 1"));
  assert.deepEqual(trials, []);
});

test("模型返回越界题号时丢弃，不凭空造答案", async (t) => {
  stubFetch(t, () =>
    okResponse(
      JSON.stringify([
        { index: 1, type: "single", selectedIndexes: [2] },
        { index: 7, type: "single", selectedIndexes: [1] },
      ]),
    ),
  );

  const result = await answerQuestions(questionsWithTwoMisses(), testConfig(), {
    questionBank: bankEntries(),
  });

  // 第 1、4 题由题库作答，第 2 题来自模型，第 3 题因越界返回而缺失。
  assert.deepEqual(
    result.answers.map((answer) => answer.index),
    [1, 2, 4],
  );
  assert.equal(result.partial, true);
  assert.match(result.note, /越界答案/);
  assert.match(result.note, /仍有 3 题未获得答案/);
});

test("题库答案优先于上次保存的答案，存档补齐题库未覆盖的题目", async (t) => {
  const calls = stubFetch(t, () => {
    throw new Error("题库与存档已覆盖全部题目，不应该发起请求");
  });

  const result = await answerQuestions(questionsWithTwoMisses(), testConfig(), {
    questionBank: bankEntries(),
    // 存档覆盖第 1 题，但题库也有第 1 题且题库为准；第 2、3 题由存档补齐。
    fallbackAnswers: [
      { index: 1, type: "single", selectedIndexes: [2] },
      { index: 2, type: "single", selectedIndexes: [2] },
      { index: 3, type: "single", selectedIndexes: [1] },
    ],
  });

  assert.equal(calls.length, 0);
  assert.equal(result.partial, false);
  assert.deepEqual(result.answers[0], { index: 1, type: "single", selectedIndexes: [1] });
  assert.deepEqual(result.answers[1], { index: 2, type: "single", selectedIndexes: [2] });
  assert.deepEqual(result.answers[2], { index: 3, type: "single", selectedIndexes: [1] });
  assert.match(result.note, /复用上次答案 2 题/);
});

test("模型调用失败时保留题库已命中的答案", async (t) => {
  stubFetch(t, () => ({ ok: false, status: 500, json: async () => ({}) }));

  const result = await answerQuestions(questionsWithTwoMisses(), testConfig(), {
    questionBank: bankEntries(),
  });

  assert.deepEqual(
    result.answers.map((answer) => answer.index),
    [1, 4],
  );
  assert.equal(result.partial, true);
  assert.match(result.note, /题库命中 2\/4 题/);
});

test("handleQuizWork 在题库命中时不调用模型，并报告命中情况", async (t) => {
  const calls = stubFetch(t, () => {
    throw new Error("题库已覆盖全部题目，不应该发起请求");
  });

  const result = await handleQuizWork({
    frame: makeFrame([question("single", "甲题？", ["甲", "乙"])]),
    page: {},
    config: testConfig(),
    dryRun: true,
    questionBank: bankEntries(),
  });

  assert.equal(calls.length, 0);
  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.answers, [{ index: 1, type: "single", selectedIndexes: [1] }]);
  assert.match(result.detail, /题库命中 1\/1 题/);
});

test("演练模式填完答案后点「暂时保存」，不提交", async (t) => {
  stubFetch(t, () => {
    throw new Error("题库已覆盖全部题目，不应该发起请求");
  });
  let saved = 0;

  const result = await handleQuizWork({
    frame: makeFrame([question("single", "甲题？", ["甲", "乙"])], { onClick: () => (saved += 1) }),
    page: {},
    config: testConfig(),
    dryRun: true,
    questionBank: bankEntries(),
  });

  assert.equal(saved, 1);
  assert.equal(result.status, "dry-run");
  assert.match(result.detail, /已点“暂时保存”把草稿留在平台/);
  assert.match(result.detail, /未提交/);
});

test("演练模式找不到「暂时保存」按钮也不失败", async (t) => {
  stubFetch(t, () => {
    throw new Error("题库已覆盖全部题目，不应该发起请求");
  });

  const result = await handleQuizWork({
    frame: makeFrame([question("single", "甲题？", ["甲", "乙"])], { saveButton: false }),
    page: {},
    config: testConfig(),
    dryRun: true,
    questionBank: bankEntries(),
  });

  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.answers, [{ index: 1, type: "single", selectedIndexes: [1] }]);
  assert.match(result.detail, /未找到“暂时保存”按钮/);
});

test("handleQuizWork 里题库答案优先于 dry-run 存档", async (t) => {
  stubFetch(t, () => {
    throw new Error("题库与存档已覆盖全部题目，不应该发起请求");
  });

  const result = await handleQuizWork({
    frame: makeFrame([
      question("single", "甲题？", ["甲", "乙"]),
      question("single", "乙题？", ["甲", "乙"]),
    ]),
    page: {},
    config: testConfig(),
    dryRun: true,
    questionBank: bankEntries(),
    // 存档里两道题都是与题库不同的旧记录，必须被题库答案覆盖。
    fallbackAnswers: [
      { index: 1, type: "single", selectedIndexes: [2] },
      { index: 2, type: "single", selectedIndexes: [1] },
    ],
  });

  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.answers[0], { index: 1, type: "single", selectedIndexes: [1] });
  assert.deepEqual(result.answers[1], { index: 2, type: "single", selectedIndexes: [2] });
});