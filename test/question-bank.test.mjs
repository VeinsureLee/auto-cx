import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalStem,
  findOptionIndex,
  lookupQuestion,
  parseQuestionBank,
  resolveBankAnswers,
  stemSimilarity,
} from "../src/assessment/question-bank.mjs";

// 固定用例尽量复刻真实题库的写法：CRLF、窗体标记、选项标记与文本分行、
// 判断题不列选项、缺「得分：」、以及章节总分与逐题得分的对应关系。
const BANK = [
  "示例作业已完成本次成绩：66.6",
  "1",
  "【单选题】第一题题干？",
  "窗体顶端",
  "A、甲选项",
  "B、乙选项",
  "C、丙选项",
  "D、丁选项",
  "窗体底端",
  "我的答案：D得分： 33.3分",
  "2",
  "【判断题】第二题题干。",
  "我的答案：√",
  "3",
  "【判断题】第三题题干。",
  "我的答案：√得分： 33.3分",
].join("\r\n");

const options = (...texts) => texts.map((text) => ({ text }));

function parse(text = BANK) {
  return parseQuestionBank(text);
}

function byStem(entries, stem) {
  return entries.find((entry) => entry.stem === stem);
}

test("解析章节总分、题型、题干与逐题得分", () => {
  const { chapters, entries } = parse();

  assert.deepEqual(chapters, [{ title: "示例作业", total: 66.6 }]);
  assert.equal(entries.length, 3);
  assert.equal(byStem(entries, "第一题题干？").type, "single");
  assert.equal(byStem(entries, "第二题题干。").type, "judge");
  assert.equal(byStem(entries, "第二题题干。").answer, "√");
  assert.deepEqual(
    byStem(entries, "第一题题干？").options.map((option) => [option.letter, option.text]),
    [["A", "甲选项"], ["B", "乙选项"], ["C", "丙选项"], ["D", "丁选项"]],
  );
});

test("窗体标记与选项换行不会污染题干和选项文本", () => {
  const { entries } = parse([
    "换行作业已完成本次成绩：100",
    "1",
    "【多选题】下列哪些正确？",
    "窗体顶端",
    "A、",
    "甲选项",
    "",
    "B、",
    "乙选项",
    "窗体底端",
    "我的答案：AB得分： 100.0分",
  ].join("\r\n"));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].stem, "下列哪些正确？");
  assert.deepEqual(entries[0].options.map((option) => option.text), ["甲选项", "乙选项"]);
});

test("得分达到满分算正确，得 0 分算错误", () => {
  const { entries } = parse([
    "零分作业已完成本次成绩：50",
    "1",
    "【单选题】答错的一题？",
    "A、甲",
    "B、乙",
    "我的答案：A得分： 0.0分",
    "2",
    "【单选题】答对的一题？",
    "A、甲",
    "B、乙",
    "我的答案：B得分： 50.0分",
  ].join("\r\n"));

  assert.equal(byStem(entries, "答错的一题？").verdict, "wrong");
  assert.equal(byStem(entries, "答对的一题？").verdict, "correct");
  assert.equal(byStem(entries, "答对的一题？").fullScore, 50);
});

test("缺「得分：」的题目用章节总分推断", () => {
  const { entries } = parse();

  const inferred = byStem(entries, "第二题题干。");
  assert.equal(inferred.score, null);
  assert.equal(inferred.inferredScore, 0); // 66.6 − (33.3 + 33.3)
  assert.equal(inferred.verdict, "wrong");
});

test("缺分题目推断不出时记为无法判定", () => {
  const { entries } = parse([
    "两处缺分已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：√",
    "2",
    "【判断题】乙题。",
    "我的答案：√",
  ].join("\r\n"));

  assert.deepEqual(entries.map((entry) => entry.verdict), ["unknown", "unknown"]);
});

test("半对的得分记为 partial，不当作正确答案", () => {
  const { entries } = parse([
    "半对作业已完成本次成绩：75",
    "1",
    "【多选题】半对的一题？",
    "A、甲",
    "B、乙",
    "C、丙",
    "我的答案：AB得分： 25.0分",
    "2",
    "【多选题】全对的一题？",
    "A、甲",
    "B、乙",
    "我的答案：AB得分： 50.0分",
  ].join("\r\n"));

  assert.equal(byStem(entries, "半对的一题？").verdict, "partial");
  assert.equal(byStem(entries, "全对的一题？").verdict, "correct");
});

test("逐题得分与章节总分对不上时整块不可信", () => {
  const { entries } = parse([
    "串块作业已完成本次成绩：100",
    "1",
    "【单选题】甲题？",
    "A、甲",
    "B、乙",
    "我的答案：A得分： 45.0分",
    "2",
    "【单选题】乙题？",
    "A、甲",
    "B、乙",
    "我的答案：A得分： 45.0分",
  ].join("\r\n"));

  assert.deepEqual(entries.map((entry) => entry.verdict), ["unknown", "unknown"]);
});

test("得分超过满分说明题数数错了，整块不可信", () => {
  const { entries } = parse([
    "题数不对已完成本次成绩：100",
    "1",
    "【单选题】甲题？",
    "A、甲",
    "我的答案：A得分： 60.0分",
    "2",
    "【单选题】乙题？",
    "A、甲",
    "我的答案：A得分： 40.0分",
  ].join("\r\n"));

  assert.deepEqual(entries.map((entry) => entry.verdict), ["unknown", "unknown"]);
});

test("题号断号说明粘贴被截断，整块不可信", () => {
  const { entries } = parse([
    "断号作业已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：√得分： 50.0分",
    "3",
    "【判断题】乙题。",
    "我的答案：√得分： 50.0分",
  ].join("\r\n"));

  assert.deepEqual(entries.map((entry) => entry.verdict), ["unknown", "unknown"]);
});

test("同名章节各自分块，按各自的题数计算满分", () => {
  const { chapters, entries } = parse([
    "同名作业已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：√得分： 50.0分",
    "2",
    "【判断题】乙题。",
    "我的答案：√得分： 50.0分",
    "同名作业已完成本次成绩：100",
    "1",
    "【判断题】丙题。",
    "我的答案：√得分： 100.0分",
  ].join("\r\n"));

  assert.equal(chapters.length, 2);
  assert.equal(byStem(entries, "甲题。").fullScore, 50);
  assert.equal(byStem(entries, "丙题。").fullScore, 100);
  assert.deepEqual(entries.map((entry) => entry.verdict), ["correct", "correct", "correct"]);
});

test("总分被截断时仍然断开章节，题目不会挂到上一章", () => {
  const { chapters, entries } = parse([
    "正常作业已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：√得分： 100.0分",
    "截断作业已完成本次成绩：",
    "1",
    "【判断题】乙题。",
    "我的答案：√得分： 100.0分",
  ].join("\r\n"));

  assert.equal(chapters.length, 2);
  assert.equal(chapters[1].total, null);
  assert.equal(byStem(entries, "乙题。").fullScore, 100);
  assert.equal(byStem(entries, "乙题。").verdict, "correct");
});

test("BOM 与 CR 单字符行尾都能解析", () => {
  const source = "单字符行尾已完成本次成绩：100\n1\n【判断题】甲题。\n我的答案：√得分： 100.0分";
  const { entries } = parse(`﻿${source.replace(/\n/g, "\r")}`);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].verdict, "correct");
});

test("空题干不会被当作万能匹配", () => {
  const { entries } = parse([
    "空题干已完成本次成绩：100",
    "1",
    "【单选题】",
    "窗体顶端",
    "窗体底端",
    "我的答案：A得分： 100.0分",
  ].join("\r\n"));

  assert.equal(entries.length, 0);
  assert.equal(lookupQuestion({ type: "single", stem: "", options: options("甲") }, entries).answer, null);
  assert.equal(lookupQuestion({ type: "single", stem: "任意题干", options: options("甲") }, entries).answer, null);
  assert.equal(canonicalStem(""), "");
});

test("按选项文本映射序数：页面选项乱序时跟随页面顺序", () => {
  const { entries } = parse();
  const question = {
    type: "single",
    stem: "第一题题干？",
    options: options("丁选项", "丙选项", "乙选项", "甲选项"),
  };

  // 题库答案是 D（即题库里的「丁选项」），它在页面上排第 1 个。
  assert.deepEqual(lookupQuestion(question, entries).answer, { selectedIndexes: [1] });

  const normal = { ...question, options: options("甲选项", "乙选项", "丙选项", "丁选项") };
  assert.deepEqual(lookupQuestion(normal, entries).answer, { selectedIndexes: [4] });
});

test("判断题按 √/× 映射为布尔值", () => {
  const { entries } = parse([
    "判断题已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：√得分： 100.0分",
  ].join("\r\n"));

  assert.deepEqual(
    lookupQuestion({ type: "judge", stem: "甲题。", options: options("对", "错") }, entries).answer,
    { trueFalse: true },
  );
});

test("题型与页面不一致、或选项文本对不上时退给模型", () => {
  const { entries } = parse();

  // 题库标判断题，页面判成单选 → 形状不兼容。
  assert.equal(
    lookupQuestion({ type: "single", stem: "第三题题干。", options: options("对", "错") }, entries).answer,
    null,
  );
  // 选项文本完全不同 → 不敢按字母瞎点。
  assert.equal(
    lookupQuestion({ type: "single", stem: "第一题题干？", options: options("戊", "己") }, entries).answer,
    null,
  );
});

test("选项文本重复时无法确定序数", () => {
  assert.equal(findOptionIndex("甲", options("甲", "甲")), -1);
  assert.equal(findOptionIndex("甲", options("乙", "甲")), 1);
  assert.equal(findOptionIndex("甲", options("乙", "丙")), -1);
});

test("题库判错的答案整理成排除项交给模型", () => {
  const { entries } = parse();
  const questions = [{ type: "judge", stem: "第二题题干。", options: options("对", "错") }];

  const result = resolveBankAnswers(questions, entries);
  assert.deepEqual(result.answers, []);
  assert.deepEqual(result.unresolved.map((item) => item.index), [1]);
  assert.equal(result.exclusions.length, 1);
  assert.deepEqual(result.exclusions[0], {
    index: 1,
    type: "judge",
    trueFalse: true,
    note: "题库曾作答该题得 0 分，已确认错误",
  });
});

test("半对的答案作为排除项时带上实际得分", () => {
  const { entries } = parse([
    "半对作业已完成本次成绩：75",
    "1",
    "【多选题】半对的一题？",
    "A、甲",
    "B、乙",
    "C、丙",
    "我的答案：AB得分： 25.0分",
    "2",
    "【多选题】全对的一题？",
    "A、甲",
    "B、乙",
    "我的答案：AB得分： 50.0分",
  ].join("\r\n"));

  const result = resolveBankAnswers(
    [{ type: "multi", stem: "半对的一题？", options: options("甲", "乙", "丙") }],
    entries,
  );

  assert.equal(result.exclusions.length, 1);
  assert.equal(result.exclusions[0].note, "题库曾作答该题仅得 25 分（未满分）");
  assert.deepEqual(result.exclusions[0].selectedIndexes, [1, 2]);
});

test("题库答案已被平台判错时不再照抄", () => {
  const { entries } = parse();
  const questions = [{ type: "single", stem: "第一题题干？", options: options("甲选项", "乙选项", "丙选项", "丁选项") }];
  const rejected = [[{ index: 1, type: "single", selectedIndexes: [4] }]];

  assert.deepEqual(resolveBankAnswers(questions, entries).answers, [{ index: 1, type: "single", selectedIndexes: [4] }]);

  const retried = resolveBankAnswers(questions, entries, { trials: rejected });
  assert.deepEqual(retried.answers, []);
  assert.deepEqual(retried.unresolved.map((item) => item.index), [1]);
  assert.match(retried.notes.join(""), /已被平台判错/);
});

test("同题干命中多个互相矛盾的正确答案时不猜", () => {
  const { entries } = parse([
    "第一次已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：√得分： 100.0分",
    "第二次已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：×得分： 100.0分",
  ].join("\r\n"));

  const lookup = lookupQuestion({ type: "judge", stem: "甲题。", options: options("对", "错") }, entries);
  assert.equal(lookup.answer, null);
  assert.match(lookup.note, /互相矛盾/);
});

test("同题干同时有正确与错误条目时用正确的、不排除", () => {
  const { entries } = parse([
    "第一次已完成本次成绩：0",
    "1",
    "【判断题】甲题。",
    "我的答案：×得分： 0.0分",
    "第二次已完成本次成绩：100",
    "1",
    "【判断题】甲题。",
    "我的答案：√得分： 100.0分",
  ].join("\r\n"));

  const lookup = lookupQuestion({ type: "judge", stem: "甲题。", options: options("对", "错") }, entries);
  assert.deepEqual(lookup.answer, { trueFalse: true });
  assert.deepEqual(lookup.exclusions, []);
});

test("判断题答案的多种写法都能识别", () => {
  const marks = [["对", true], ["是", true], ["√", true], ["错", false], ["否", false], ["×", false]];
  for (const [mark, expected] of marks) {
    const { entries } = parse([
      "判断题已完成本次成绩：100",
      "1",
      "【判断题】甲题。",
      `我的答案：${mark}得分： 100.0分`,
    ].join("\r\n"));
    assert.deepEqual(
      lookupQuestion({ type: "judge", stem: "甲题。", options: options("对", "错") }, entries).answer,
      { trueFalse: expected },
      `无法识别「${mark}」`,
    );
  }
});

test("选项字母跳号时只按实际存在的字母映射", () => {
  const { entries } = parse([
    "跳号选项已完成本次成绩：100",
    "1",
    "【单选题】甲题？",
    "A、甲",
    "C、丙",
    "我的答案：C得分： 100.0分",
  ].join("\r\n"));

  assert.deepEqual(
    lookupQuestion({ type: "single", stem: "甲题？", options: options("甲", "丙") }, entries).answer,
    { selectedIndexes: [2] },
  );
});

test("题干匹配容忍全角半角、题型标签与各种标点写法", () => {
  const { entries } = parse([
    "容错作业已完成本次成绩：100",
    "1",
    "【单选题】以下哪项占 50％ ？",
    "A、甲",
    "B、乙",
    "我的答案：A得分： 100.0分",
  ].join("\r\n"));
  assert.equal(entries.length, 1);

  const variants = [
    "以下哪项占 50% ？",
    "（单选题）以下哪项占 50%?",
    "以下哪项占５０％？",
    " 以下哪项占50%  ",
  ];
  for (const stem of variants) {
    const lookup = lookupQuestion({ type: "single", stem, options: options("甲", "乙") }, entries);
    assert.deepEqual(lookup.answer, { selectedIndexes: [1] }, `无法匹配「${stem}」`);
  }
});

test("反义题干必须区分开：不做模糊匹配", () => {
  // 中文题库里「正确的是」和「不正确的是」选项完全相同、题干只差一个字，
  // 相似度高达 0.91，比正常的近似命中还高 —— 因此只能精确匹配。
  const right = "下列选项中关于创业机会的说法正确的是（）";
  const wrong = "下列选项中关于创业机会的说法不正确的是（）";

  assert.ok(stemSimilarity(right, wrong) > 0.9);
  assert.notEqual(canonicalStem(right), canonicalStem(wrong));

  const { entries } = parse([
    "反义作业已完成本次成绩：100",
    "1",
    `【单选题】${right}`,
    "A、甲",
    "B、乙",
    "我的答案：A得分： 100.0分",
  ].join("\r\n"));

  assert.deepEqual(
    lookupQuestion({ type: "single", stem: right, options: options("甲", "乙") }, entries).answer,
    { selectedIndexes: [1] },
  );
  assert.equal(
    lookupQuestion({ type: "single", stem: wrong, options: options("甲", "乙") }, entries).answer,
    null,
  );
});

test("题干未收录时报告最相近的相似度", () => {
  const { entries } = parse();
  const question = {
    type: "single",
    stem: "第一题题干？",
    options: options("甲选项", "乙选项", "丙选项", "丁选项"),
  };
  assert.equal(lookupQuestion(question, entries).matched, true);

  // 选项也对不上才会走到「未收录」这条路上（选项一致时会按指纹命中）。
  const missing = { ...question, stem: "第一题题干？请选出正确的答案", options: options("戊", "己") };
  const lookup = lookupQuestion(missing, entries);
  assert.equal(lookup.matched, false);
  assert.ok(lookup.nearest.similarity >= 0.5, `相似度 ${lookup.nearest.similarity} 应达到报告门槛`);
  assert.equal(lookup.nearest.stem, "第一题题干？");

  const result = resolveBankAnswers([missing], entries);
  assert.equal(result.unresolved.length, 1);
  // 摘要进报告，逐字对照在 diagnostics 里（learning 层写进诊断日志）。
  assert.match(result.notes.join(""), /题库未收录 1 题（最相近题干相似度 0\.\d\d，明细见诊断日志）/);
  assert.equal(result.diagnostics[0].stem, "第一题题干？请选出正确的答案");
  assert.equal(result.diagnostics[0].nearestStem, "第一题题干？");

  const absent = { ...question, stem: "完全无关的另一道题", options: options("庚", "辛") };
  assert.match(
    resolveBankAnswers([absent], entries).notes.join(""),
    /无相近题干/,
  );
});

test("未命中时连带报出页面题型、题干与选项数，便于定位", () => {
  const { entries } = parse();
  const result = resolveBankAnswers(
    [{ type: "single", stem: "未收录的题？", options: options("甲", "乙") }],
    entries,
  );

  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(
    { ...result.diagnostics[0], nearestStem: undefined, similarity: undefined },
    {
      index: 1,
      type: "single",
      stem: "未收录的题？",
      optionCount: 2,
      options: ["甲", "乙"],
      matched: false,
      nearestStem: undefined,
      similarity: undefined,
    },
  );
});

test("页面题型识别不出来时点明是选择器问题，而不是「题库没收这道题」", () => {
  const { entries } = parse();
  // 选项选择器一个选项都没抓到、题干也是空的时候，题型会退化成 other，
  // 于是同题型比对被整体过滤，相似度只剩 0 —— 必须把它和「题库没收录」区分开。
  const result = resolveBankAnswers([{ type: "other", stem: "", options: [] }], entries);

  assert.equal(result.diagnostics[0].optionCount, 0);
  assert.equal(result.diagnostics[0].similarity, 0);
  assert.match(result.notes.join(""), /无相近题干/);
  assert.match(result.notes.join(""), /页面题型无法识别（选项选择器可能没抓到选项）/);
});

test("题干被平台做了字体混淆时改用选项指纹匹配", () => {
  const { entries } = parse();
  // 真实症状：题干取回来是一串生僻字（步→唭、为→惟…），选项文本却是干净的。
  // 这时按选项文本集合匹配，而且页面打乱选项顺序也不受影响。
  const question = {
    type: "single",
    stem: "唭唭惟唬战略是唰缺乏资源的情况唲",
    options: options("丁选项", "丙选项", "乙选项", "甲选项"),
  };

  const lookup = lookupQuestion(question, entries);
  assert.equal(lookup.matched, true);
  // 题库答案是 D（丁选项），它在页面上排第 1 个。
  assert.deepEqual(lookup.answer, { selectedIndexes: [1] });
});

test("选项不足三个（判断题）时不做指纹匹配，避免「对/错」这类通用选项乱配", () => {
  const { entries } = parse();
  const lookup = lookupQuestion(
    { type: "judge", stem: "完全乱码的题干", options: options("A 对", "B 错") },
    entries,
  );
  assert.equal(lookup.answer, null);
  assert.equal(lookup.matched, false);
});

test("题干乱码又无选项区分度时，按同章节+同题型+同长度对齐", () => {
  const { entries } = parse([
    "对齐作业已完成本次成绩：100",
    "1",
    "【单选题】甲题？",
    "A、甲",
    "B、乙",
    "C、丙",
    "我的答案：A得分： 33.3分",
    "2",
    "【判断题】这是第一道判断题的题干内容。",
    "我的答案：√得分： 33.3分",
    "3",
    "【判断题】短题干。",
    "我的答案：×得分： 33.4分",
  ].join("\r\n"));

  const pageQuestions = [
    // 第 1 题靠选项指纹命中，从而把章节确定下来。
    { type: "single", stem: "噭噭曠曜嚁嚂", options: options("甲", "乙", "丙") },
    // 后两题是判断题，选项只有「对/错」，只能靠「同题型 + 同题干长度」唯一对齐：
    // 字体混淆只换字、不改长度，长度因此是可靠指纹。
    { type: "judge", stem: "这是第一道判断题的题干内容。".replace(/[一-鿿]/g, "囍"), options: options("A 对", "B 错") },
    { type: "judge", stem: "囍囍囍。", options: options("A 对", "B 错") },
  ];
  assert.equal(pageQuestions[1].stem.length, "这是第一道判断题的题干内容。".length);
  assert.equal(pageQuestions[2].stem.length, "短题干。".length);

  const result = resolveBankAnswers(pageQuestions, entries);
  assert.deepEqual(result.answers, [
    { index: 1, type: "single", selectedIndexes: [1] },
    { index: 2, type: "judge", trueFalse: true },
    { index: 3, type: "judge", trueFalse: false },
  ]);
  assert.equal(result.unresolved.length, 0);
  assert.match(result.notes.join(""), /第 2、3 题题干被平台做了字体混淆/);
  assert.match(result.notes.join(""), /已按「同章节\+同题型\+同长度」对齐到题库「对齐作业」/);
});

test("章节内没有同长度条目时不猜，仍然交给模型", () => {
  const { entries } = parse();
  const result = resolveBankAnswers(
    [
      // 靠选项指纹确定章节
      { type: "single", stem: "噭噭曠曜嚁嚂", options: options("甲选项", "乙选项", "丙选项", "丁选项") },
      // 判断题的长度在题库里没有唯一对应（两个判断都是 5 个字）
      { type: "judge", stem: "囍囍囍囍囍", options: options("A 对", "B 错") },
    ],
    entries,
  );

  assert.deepEqual(result.answers, [{ index: 1, type: "single", selectedIndexes: [4] }]);
  assert.deepEqual(result.unresolved.map((item) => item.index), [2]);
  assert.ok(!result.notes.join("").includes("同长度"));
});

test("整份作业都没命中章节时不做任何对齐", () => {
  const { entries } = parse();
  const result = resolveBankAnswers(
    [
      { type: "judge", stem: "囍囍囍囍囍", options: options("A 对", "B 错") },
      { type: "judge", stem: "囍囍囍", options: options("A 对", "B 错") },
    ],
    entries,
  );

  assert.deepEqual(result.answers, []);
  assert.deepEqual(result.unresolved.map((item) => item.index), [1, 2]);
});

// 真实症状：题干与选项都被换字，且同一题内换字一致（资→垐、源→垊 在题干和四个
// 选项里都一样），选项标记写成「A 」（只带空格）。
const OBFUSCATED = [
  "混淆作业已完成本次成绩：100",
  "1",
  "【单选题】创业资源开发的推进方法不包括（）",
  "A、寻找式资源整合",
  "B、累积式资源整合",
  "C、开拓式资源整合",
  "D、递进式资源整合",
  "我的答案：D得分： 50.0分",
  "2",
  "【多选题】资源整合的原则包括（）",
  "A、识别利益相关者及其利益",
  "B、构建共赢机制",
  "C、维持信任长期合作",
  "我的答案：ABC得分： 50.0分",
].join("\r\n");

const OBFUSCATED_STEM = "创业垐垊垎垏垌推进方法不垑垍（）";
const OBFUSCATED_OPTIONS = ["A 垕找垖垐垊垓垔", "B 垗积垖垐垊垓垔", "C 垎拓垖垐垊垓垔", "D 垘进垖垐垊垓垔"];

function obfuscatedQuiz({ reverseOptions = false } = {}) {
  const optionTexts_ = reverseOptions ? [...OBFUSCATED_OPTIONS].reverse() : OBFUSCATED_OPTIONS;
  return [
    { type: "single", stem: OBFUSCATED_STEM, options: optionTexts_.map((text) => ({ text })) },
    // 第 2 题没被混淆，靠它把章节确定下来。
    {
      type: "multi",
      stem: "资源整合的原则包括（）",
      options: ["识别利益相关者及其利益", "构建共赢机制", "维持信任长期合作"].map((text) => ({ text })),
    },
  ];
}

test("题干与选项都被换字时，用题干换字表验证选项顺序后按位置取答案", () => {
  const { entries } = parse(OBFUSCATED);
  const result = resolveBankAnswers(obfuscatedQuiz(), entries);
  const answers = [...result.answers].sort((left, right) => left.index - right.index);

  assert.deepEqual(answers, [
    { index: 1, type: "single", selectedIndexes: [4] },
    { index: 2, type: "multi", selectedIndexes: [1, 2, 3] },
  ]);
  assert.equal(result.unresolved.length, 0);
  assert.match(result.notes.join(""), /第 1 题连选项都被混淆，已用题干换字表验证选项顺序一致后按位置取答案/);
});

test("选项顺序与题库不一致时按位置取答案会被拒绝", () => {
  const { entries } = parse(OBFUSCATED);
  const result = resolveBankAnswers(obfuscatedQuiz({ reverseOptions: true }), entries);

  // 换字表预测出的字符位置与页面实际不符 ⇒ 不能假设顺序一致，交回模型。
  assert.deepEqual(
    result.answers.map((answer) => answer.index),
    [2],
  );
  assert.deepEqual(result.unresolved.map((item) => item.index), [1]);
  assert.ok(!result.notes.join("").includes("按位置取答案"));
});

test("题干匹配忽略空白与标点差异", () => {
  const { entries } = parse();
  const question = {
    type: "single",
    stem: " 第一题题干 ? ",
    options: options("甲选项", "乙选项", "丙选项", "丁选项"),
  };

  assert.equal(canonicalStem("第一题题干？"), canonicalStem(" 第一题题干 ? "));
  assert.deepEqual(lookupQuestion(question, entries).answer, { selectedIndexes: [4] });
});
