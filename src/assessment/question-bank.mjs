// 本地题库：把人工整理的《课后题库.md》解析成可直接作答的答案。
//
// 本模块是纯函数模块，不读写文件；文件读取由 learning/run-study.mjs 负责。
// 解析结果会被所有并发 worker 共享，因此调用方必须把 entries 当作只读；
// lookupQuestion 每次返回全新对象，绝不把映射结果写回 entries。
//
// 题库格式（从平台作业页面复制粘贴，行尾通常是 CRLF）：
//
//   <章节标题>已完成本次成绩：<该次作业总分>
//   1
//   【单选题】题干……
//   窗体顶端
//   A、选项一
//   B、
//   选项二的文本
//   窗体底端
//   我的答案：D得分： 25.0分
//
// 判定规则：每题满分 = 100 / 该次作业题数；只有得分达到满分（容差 0.15）
// 才算「100% 正确」，可以直接照抄；得分没到满分说明这个答案组合是错的或不
// 完整的，需要提醒模型避开。缺「得分：」的题目用「该次作业总分 − 其它已知
// 得分之和」推断，推断不出就当作无法判定，整题交给模型。
//
// 注意：本题库允许同名章节出现多次（同一次作业的多次作答，或不同章节重名）。
// 每个章节头都独立分块，绝不按标题合并 —— 块内题数与满分各不相同。

const CHAPTER_HEADER_PATTERN = /^(.*?)已完成本次成绩[：:]\s*([\d.]+)\s*$/;
const CHAPTER_MARKER_PATTERN = /已完成本次成绩/;
const QUESTION_NUMBER_PATTERN = /^\d{1,3}$/;
const TYPE_LABEL_PATTERN = /【\s*(单选题|多选题|判断题|填空题|简答题)\s*】/;
const OPTION_PATTERN = /^([A-Za-z])[.、)）]\s*(.*)$/;
const ANSWER_PATTERN = /^我的答案[：:]\s*(.*)$/;
const WINDOW_MARKER_PATTERN = /^窗体(?:顶端|底端)$/;
const SCORE_PATTERN = /得分[：:]\s*([\d.]+)\s*分?/;
const TRAILING_SCORE_PATTERN = /得分[：:][\s\S]*$/;

const TYPE_BY_LABEL = {
  单选题: "single",
  多选题: "multi",
  判断题: "judge",
  填空题: "fill",
  简答题: "essay",
};

const VERDICT_CORRECT = "correct";
const VERDICT_PARTIAL = "partial";
const VERDICT_WRONG = "wrong";
const VERDICT_UNKNOWN = "unknown";

// 得分与满分之间的比较容差：100/3 = 33.333…，平台只会显示到 33.3 或 33.4。
const SCORE_TOLERANCE = 0.15;

// 报告「最相近题干相似度」的门槛，低于它只说明题库里没有这道题的影子。
const NEAR_MISS_FLOOR = 0.5;

const QUESTION_BANK_FULL_SCORE = 100;

const TRUE_MARKS = new Set(["√", "✓", "对", "是", "正确", "t", "true"]);
const FALSE_MARKS = new Set(["×", "✗", "x", "错", "否", "错误", "f", "false"]);

function round2(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return rounded === 0 ? 0 : rounded; // 消除 -0
}

// 题干匹配键：去掉题型标签与全部空白标点，全角字符折成半角，只保留
// 汉字、字母和数字。题库是人工复制粘贴的，标点、空格、全角/半角最容易漂移，
// 一律忽略；汉字本身必须完全一致 —— 不能做模糊匹配，因为中文题库里
// 「下列…正确的是」和「下列…不正确的是」选项完全相同、题干只差一个字。
export function canonicalStem(text) {
  return String(text ?? "")
    .replace(/【[^】]*】/g, "")
    .replace(/[（(]\s*(?:单选|多选|判断|填空|简答)题\s*[）)]/g, "")
    .replace(/^(?:单选|多选|判断|填空|简答)题[：:、.]?/, "")
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, "")
    .toLowerCase()
    .replace(/[^0-9a-z一-鿿]/g, "");
}

// 选项文本匹配键：题库与页面上的选项都带「A、」这类前缀，比对时去掉。
// 页面上的前缀有两种写法：「A、」（带标点）与「A 」（只带空格，判断题常见），
// 后者只认单个字母加空白，免得把「150定律」这种以数字开头的正文当标记切掉。
function canonicalOptionText(text) {
  const value = typeof text === "string" ? text : text?.text ?? "";
  return canonicalStem(
    String(value ?? "")
      .replace(/^(?:[(（][A-Za-z0-9Ａ-Ｚａ-ｚ０-９][)）]\s*|[A-Za-zＡ-Ｚａ-ｚ][.、,，)）]\s*)/, "")
      .replace(/^[A-Za-zＡ-Ｚａ-ｚ]\s+/, ""),
  );
}

// 题目文本的字符二元组，用来估算两道题的相似度（只用于诊断，不用于匹配）。
function bigramsOf(canonical) {
  const grams = new Set();
  for (let index = 0; index + 1 < canonical.length; index += 1) {
    grams.add(canonical.slice(index, index + 2));
  }
  return grams;
}

const bigramCache = new WeakMap();

function cachedBigrams(entry) {
  let grams = bigramCache.get(entry);
  if (!grams) {
    grams = bigramsOf(entry.canonicalStem ?? "");
    bigramCache.set(entry, grams);
  }
  return grams;
}

function diceCoefficient(left, right) {
  if (!left.size || !right.size) {
    return 0;
  }
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) {
      shared += 1;
    }
  }
  return (2 * shared) / (left.size + right.size);
}

// 两道题（或两段题干）的相似度，0..1。相同题型下才有参考意义。
export function stemSimilarity(left, right) {
  const a = canonicalStem(left);
  const b = canonicalStem(right);
  if (!a || !b) {
    return 0;
  }
  return a === b ? 1 : diceCoefficient(bigramsOf(a), bigramsOf(b));
}

// 题库里与这道题干最接近的条目，仅用于把「为什么没命中」讲清楚：
// 相似度接近 1 说明题库收了这题但文字有出入，接近 0 说明题库根本没收录。
function nearestEntry(key, type, entries) {
  if (!key) {
    return null;
  }
  const keyGrams = bigramsOf(key);
  let best = null;
  for (const entry of entries ?? []) {
    if (type && entry.type && entry.type !== type) {
      continue;
    }
    const similarity = diceCoefficient(keyGrams, cachedBigrams(entry));
    if (!best || similarity > best.similarity) {
      best = { entry, similarity };
    }
  }
  return best;
}

function optionTexts(options = []) {
  return options.map((option) => (typeof option === "string" ? option : option?.text ?? ""));
}

// 把题库选项文本映射回页面选项的 1-based 序数：页面可能打乱选项顺序，
// 所以按文本匹配而不是按字母位置。匹配到多个（文本重复）视为无法确定。
export function findOptionIndex(optionText, questionOptions = []) {
  const target = canonicalOptionText(optionText);
  if (!target) {
    return -1;
  }
  const indexes = [];
  optionTexts(questionOptions).forEach((text, index) => {
    if (canonicalOptionText(text) === target) {
      indexes.push(index);
    }
  });
  return indexes.length === 1 ? indexes[0] : -1;
}

function judgeValue(answer) {
  const text = String(answer ?? "").trim().toLowerCase();
  if (TRUE_MARKS.has(text)) return true;
  if (FALSE_MARKS.has(text)) return false;
  return null;
}

function splitChapters(lines) {
  const chapters = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const header = trimmed.match(CHAPTER_HEADER_PATTERN);
    if (header) {
      current = { title: header[1].trim(), total: Number(header[2]), lines: [] };
      chapters.push(current);
      continue;
    }
    // 总分被截断时也必须断开章节，否则这些题会挂到上一章、沿用错误的题数与满分。
    if (CHAPTER_MARKER_PATTERN.test(trimmed)) {
      current = {
        title: trimmed.replace(CHAPTER_MARKER_PATTERN, "").replace(/[：:]\s*$/, "").trim(),
        total: null,
        lines: [],
      };
      chapters.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  return chapters;
}

function splitQuestionBlocks(lines) {
  const blocks = [];
  const numbers = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (QUESTION_NUMBER_PATTERN.test(trimmed)) {
      current = [];
      blocks.push(current);
      numbers.push(Number(trimmed));
      continue;
    }
    if (current) {
      current.push(line);
      continue;
    }
    // 题号偶尔会缺失：遇到题型标签就补开一道新题，其余杂项丢弃。
    if (TYPE_LABEL_PATTERN.test(trimmed)) {
      current = [];
      blocks.push(current);
      numbers.push(null);
    }
  }
  // 题号必须从 1 连续排到 n：断号说明粘贴被截断，题数与满分都不可信。
  const sequential = numbers.every((value, index) => value === index + 1);
  return { blocks, sequential };
}

// 选项可能写成「A、创业知识」，也可能「A、」独占一行、正文在下一行。
function parseQuestionBlock(lines) {
  let type = null;
  let stage = "stem";
  let pendingOption = null;
  const stemParts = [];
  const options = [];
  let answer = null;
  let score = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || WINDOW_MARKER_PATTERN.test(line)) {
      continue;
    }

    const answerMatch = line.match(ANSWER_PATTERN);
    if (answerMatch) {
      const rest = answerMatch[1];
      const scoreMatch = rest.match(SCORE_PATTERN);
      score = scoreMatch ? Number(scoreMatch[1]) : null;
      answer = rest.replace(SCORE_PATTERN, "").replace(TRAILING_SCORE_PATTERN, "").trim();
      pendingOption = null;
      continue;
    }

    const label = line.match(TYPE_LABEL_PATTERN);
    if (label && !type && stage === "stem" && options.length === 0) {
      type = TYPE_BY_LABEL[label[1]] ?? null;
      const rest = line.replace(TYPE_LABEL_PATTERN, "").trim();
      if (rest) {
        stemParts.push(rest);
      }
      continue;
    }

    const optionMatch = line.match(OPTION_PATTERN);
    if (optionMatch && (stage === "options" || stemParts.length || type)) {
      stage = "options";
      pendingOption = { letter: optionMatch[1].toUpperCase(), text: optionMatch[2].trim() };
      options.push(pendingOption);
      continue;
    }

    if (stage === "stem") {
      stemParts.push(line);
    } else if (pendingOption) {
      pendingOption.text = pendingOption.text ? `${pendingOption.text}${line}` : line;
    }
  }

  return { type, stem: stemParts.join(""), options, answer, score };
}

// 每题满分固定为 100 / 该次作业题数（与题库里逐题得分能对上）。
// 章节总分只用来推断缺分题目，因此推断本身会让总和自洽，谈不上交叉校验；
// 真正能校验「题数没数错」的是：任何一题的得分都不该超过满分。
function computeVerdicts(questions, chapterTotal, sequential) {
  const count = questions.length;
  const fullScore = count ? QUESTION_BANK_FULL_SCORE / count : null;

  for (const question of questions) {
    question.fullScore = fullScore === null ? null : round2(fullScore);
    question.verdict = VERDICT_UNKNOWN;
  }
  if (!count || !sequential) {
    return;
  }

  const scored = questions.filter((question) => question.score != null);
  const unscored = questions.filter((question) => question.score == null);
  const knownSum = scored.reduce((sum, question) => sum + question.score, 0);

  // 得分超过满分说明题数不对，整块都不可信。
  if (scored.some((question) => question.score > fullScore + SCORE_TOLERANCE)) {
    return;
  }

  if (unscored.length === 1 && Number.isFinite(chapterTotal)) {
    const inferred = round2(chapterTotal - knownSum);
    if (inferred >= 0 && inferred <= fullScore + SCORE_TOLERANCE) {
      unscored[0].inferredScore = inferred;
    }
  }

  // 没有缺分题时，逐题得分之和应当等于章节总分；对不上说明分块串了。
  if (Number.isFinite(chapterTotal) && unscored.length === 0) {
    const tolerance = Math.max(0.2, count * 0.06);
    if (Math.abs(knownSum - chapterTotal) > tolerance) {
      return;
    }
  }

  for (const question of questions) {
    const score = question.score ?? question.inferredScore ?? null;
    if (score == null || score < 0 || score > fullScore + SCORE_TOLERANCE) {
      continue;
    }
    if (score >= fullScore - SCORE_TOLERANCE) {
      question.verdict = VERDICT_CORRECT;
    } else if (score > 0) {
      question.verdict = VERDICT_PARTIAL;
    } else {
      question.verdict = VERDICT_WRONG;
    }
  }
}

function buildEntry(question, chapter) {
  return {
    chapterTitle: chapter.title,
    chapterTotal: chapter.total,
    type: question.type,
    stem: question.stem,
    canonicalStem: canonicalStem(question.stem),
    canonicalLength: canonicalStem(question.stem).length,
    optionFingerprint: optionFingerprint(question.type, question.options),
    options: question.options,
    answer: question.answer,
    score: question.score,
    inferredScore: question.inferredScore ?? null,
    fullScore: question.fullScore,
    verdict: question.verdict,
  };
}

// 一道题的选项文本集合指纹（与顺序无关）。平台只对题干做了字体混淆，选项文本
// 是干净的，所以题干乱码时改用整题选项当指纹 —— 它比题干更有区分度，也不受
// 页面打乱选项顺序影响。判断题只有「对/错」，不具区分度，因此返回 null。
function optionFingerprint(type, options) {
  if (type !== "single" && type !== "multi") {
    return null;
  }
  const texts = optionTexts(options)
    .map((text) => canonicalOptionText(text))
    .filter(Boolean);
  if (texts.length < 3) {
    return null;
  }
  return [...texts].sort().join("");
}

export function parseQuestionBank(text) {
  const normalized = String(text ?? "").replace(/^﻿/, "");
  const chapters = splitChapters(normalized.split(/\r\n|[\r\n]/));
  const entries = [];

  for (const chapter of chapters) {
    const { blocks, sequential } = splitQuestionBlocks(chapter.lines);
    const questions = blocks
      .map(parseQuestionBlock)
      .filter((question) => canonicalStem(question.stem));
    computeVerdicts(questions, chapter.total, sequential);
    for (const question of questions) {
      entries.push(buildEntry(question, chapter));
    }
  }

  return { chapters: chapters.map(({ title, total }) => ({ title, total })), entries };
}

// 把题库条目换算成 answerer 需要的答案形状（selectedIndexes / trueFalse）。
// 题型与页面不一致、或选项文本对不上时返回 null —— 宁可退给模型也不误填，
// 否则一道题的形状不合法会让整份作业通不过 shouldSubmit 而无法提交。
function selectionFromEntry(entry, question) {
  if (!entry || entry.type !== question?.type) {
    return null;
  }
  if (entry.type === "judge") {
    const trueFalse = judgeValue(entry.answer);
    return trueFalse === null ? null : { trueFalse };
  }
  if (entry.type !== "single" && entry.type !== "multi") {
    return null;
  }

  const letters = [...new Set(String(entry.answer ?? "").toUpperCase().match(/[A-Z]/g) ?? [])];
  if (!letters.length) {
    return null;
  }

  const selectedIndexes = [];
  for (const letter of letters) {
    const option = entry.options.find((candidate) => candidate.letter === letter);
    if (!option?.text) {
      return null;
    }
    const index = findOptionIndex(option.text, question.options);
    if (index < 0) {
      return null;
    }
    selectedIndexes.push(index + 1);
  }

  selectedIndexes.sort((left, right) => left - right);
  if (entry.type === "single" && selectedIndexes.length !== 1) {
    return null;
  }
  return { selectedIndexes };
}

// 选项文本也被字体混淆时，靠选项文本取不到答案，只能按「题库与页面的选项顺序
// 一致」取位置。这个假设必须先验证：同一题内的换字是一致的（资→垐 在题干和四个
// 选项里都一样），所以拿题干 1:1 对齐得到的换字表去预测选项文本，预测出的位置
// 必须与页面实际字符吻合；对不上就说明顺序不一致，退回模型，绝不瞎点。
function positionalSelection(entry, question) {
  const bankStem = canonicalStem(entry.stem);
  const pageStem = canonicalStem(question.stem);
  if (!bankStem || bankStem.length !== pageStem.length) {
    return null;
  }
  const swap = new Map();
  for (let index = 0; index < bankStem.length; index += 1) {
    if (bankStem[index] !== pageStem[index]) {
      swap.set(bankStem[index], pageStem[index]);
    }
  }
  if (!swap.size) {
    return null; // 题干没被混淆，走选项文本映射就够了
  }

  const bankOptions = optionTexts(entry.options).map(canonicalOptionText);
  const pageOptions = optionTexts(question.options).map(canonicalOptionText);
  if (!bankOptions.length || bankOptions.length !== pageOptions.length) {
    return null;
  }

  let verified = 0;
  for (let index = 0; index < bankOptions.length; index += 1) {
    if (bankOptions[index].length !== pageOptions[index].length) {
      return null;
    }
    for (let at = 0; at < bankOptions[index].length; at += 1) {
      const source = bankOptions[index][at];
      if (!swap.has(source)) {
        continue;
      }
      verified += 1;
      if (swap.get(source) !== pageOptions[index][at]) {
        return null; // 换字表对不上 ⇒ 选项顺序与题库不同
      }
    }
  }
  if (!verified) {
    return null; // 一个可比对的位置都没有，不足以确认顺序
  }

  const letters = [...new Set(String(entry.answer ?? "").toUpperCase().match(/[A-Z]/g) ?? [])];
  const selectedIndexes = letters.map((letter) => letter.charCodeAt(0) - 64);
  if (
    !selectedIndexes.length ||
    selectedIndexes.some((index) => index < 1 || index > pageOptions.length)
  ) {
    return null;
  }
  selectedIndexes.sort((left, right) => left - right);
  if (entry.type === "single" && selectedIndexes.length !== 1) {
    return null;
  }
  return { selectedIndexes };
}

// 对齐到题库条目之后取答案。优先按选项文本映射；选项也被混淆了才退回按位置取，
// 并标记出来，好让调用方在日志里如实说明这一答案是怎么来的。
function alignSelection(entry, question) {
  const byText = selectionFromEntry(entry, question);
  if (byText) {
    return { selection: byText, positional: false };
  }
  const byPosition = positionalSelection(entry, question);
  return byPosition ? { selection: byPosition, positional: true } : null;
}

// 答案组合的指纹，用来判断「题库给的答案是不是已经被平台判错过」。
function answerSignature(answer) {
  if (!answer || typeof answer !== "object") {
    return null;
  }
  if (typeof answer.trueFalse === "boolean") {
    return `judge:${answer.trueFalse}`;
  }
  if (Array.isArray(answer.selectedIndexes) && answer.selectedIndexes.length) {
    const indexes = [...new Set(answer.selectedIndexes.map(Number))]
      .filter(Number.isInteger)
      .sort((left, right) => left - right);
    return indexes.length ? `choice:${indexes.join(",")}` : null;
  }
  const text = answer.fillText ?? answer.essayText;
  return typeof text === "string" && text.trim() ? `text:${text.trim()}` : null;
}

// 试错表里的条目既可能是单个答案，也可能是「一次作答的整组答案」，两种都要摊平。
function rejectedByIndex(trials) {
  const rejected = new Map();
  const add = (answer) => {
    const index = Number(answer?.index);
    const signature = answerSignature(answer);
    if (!Number.isInteger(index) || !signature) {
      return;
    }
    if (!rejected.has(index)) {
      rejected.set(index, new Set());
    }
    rejected.get(index).add(signature);
  };
  for (const trial of Array.isArray(trials) ? trials : []) {
    if (Array.isArray(trial)) {
      trial.forEach(add);
    } else {
      add(trial);
    }
  }
  return rejected;
}

function exclusionNote(entry) {
  const score = entry.score ?? entry.inferredScore ?? 0;
  return entry.verdict === VERDICT_PARTIAL
    ? `题库曾作答该题仅得 ${score} 分（未满分）`
    : "题库曾作答该题得 0 分，已确认错误";
}

// 在题库里查一道页面题目。返回：
//   answer         —— 可直接使用的答案片段（题库判定 100% 正确，且没被判错过）
//   exclusions     —— 题库里答错/半对的答案组合，整理成试错记录让模型避开
//   note           —— 命中但不可用的原因，便于排查
//   matched        —— 题干是否在题库里找到了（不是「有没有答案」）
//   nearest        —— 未命中时题库里最相近的条目及其相似度，用来判断是「题库没
//                     收录这道题」还是「收录了但文字有出入」
export function lookupQuestion(question, entries = [], rejected = new Map()) {
  const key = canonicalStem(question?.stem);
  const stemMatches = key
    ? (entries ?? []).filter((entry) => entry.canonicalStem === key)
    : [];
  // 题干被字体混淆时取回来是一串生僻字，对不上是必然的；而选项文本是干净的，
  // 所以题干对不上就改用整题选项指纹。
  const fingerprint = optionFingerprint(question?.type, question?.options);
  const matches = stemMatches.length
    ? stemMatches
    : fingerprint
      ? (entries ?? []).filter(
          (entry) => entry.type === question.type && entry.optionFingerprint === fingerprint,
        )
      : [];

  if (!matches.length) {
    const nearest = nearestEntry(key, question?.type, entries);
    return {
      answer: null,
      exclusions: [],
      note: null,
      matched: false,
      matchedEntries: [],
      nearest: nearest ? { stem: nearest.entry.stem, similarity: nearest.similarity } : null,
    };
  }

  const rejectedHere = rejected.get(Number(question?.index)) ?? new Set();
  const usable = (entry) => selectionFromEntry(entry, question);
  const exclusions = [];
  const hit = (answer, extra = {}) => ({
    answer,
    exclusions: exclusions.map(({ selection, note }) => ({ ...selection, note })),
    note: null,
    matched: true,
    matchedEntries: matches.map((entry) => ({
      stem: entry.canonicalStem,
      chapterTitle: entry.chapterTitle,
    })),
    nearest: null,
    ...extra,
  });

  for (const entry of matches) {
    const selection = usable(entry);
    if (!selection || entry.verdict === VERDICT_CORRECT) {
      continue;
    }
    const signature = answerSignature(selection);
    if (signature && !exclusions.some((item) => item.signature === signature)) {
      exclusions.push({ signature, entry, selection, note: exclusionNote(entry) });
    }
  }

  const correct = matches
    .filter((entry) => entry.verdict === VERDICT_CORRECT)
    .map((entry) => ({ entry, selection: usable(entry) }))
    .filter((item) => item.selection);

  if (!correct.length) {
    return hit(null, { note: exclusions.length ? null : "题库答案与页面选项无法对应，改为询问模型" });
  }

  // 同一题干命中多次且答案互相矛盾时，不赌，交给模型。
  if (new Set(correct.map((item) => JSON.stringify(item.selection))).size > 1) {
    return hit(null, { note: "题库中同一题干存在互相矛盾的正确答案" });
  }

  // 该答案组合已被平台判错（例如上一次重答失败）：不再照抄，改问模型。
  const answer = correct[0].selection;
  if (rejectedHere.has(answerSignature(answer))) {
    return hit(null, { note: "题库答案已被平台判错，改为询问模型" });
  }

  return hit(answer, { exclusions: [] });
}

// 命中最多的那个章节，用来给剩下的题做位置对齐。
function countChapter(lookups) {
  const counts = new Map();
  for (const lookup of lookups) {
    for (const entry of lookup.matchedEntries ?? []) {
      counts.set(entry.chapterTitle, (counts.get(entry.chapterTitle) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [title, count] of counts) {
    if (!best || count > best.count) {
      best = { title, count };
    }
  }
  return best?.title ?? null;
}

// 按题库批量解析整份作业，拆成「已命中的答案」「需要问模型的题目」「需要避开的错误答案」。
export function resolveBankAnswers(questions = [], entries = [], { trials = [] } = {}) {
  const rejected = rejectedByIndex(trials);
  const notes = [];
  const exclusions = [];
  const misses = [];
  // 每道没能直接用上题库答案的题都留一份现场，交给 learning 层打印。
  // 只报「未命中多少题」不足以定位：题干为空、题型识别成 other、选项一个没抓到
  // 都会表现成「没命中」，但原因和修法完全不同。
  const diagnostics = [];

  const lookups = questions.map((question, index) =>
    lookupQuestion({ ...question, index: index + 1 }, entries, rejected),
  );
  const answers = lookups
    .map((lookup, index) =>
      lookup.answer ? { index: index + 1, type: questions[index].type, ...lookup.answer } : null,
    )
    .filter(Boolean);

  // 平台对题干做了字体反爬：题干取回来是一串生僻字，逐字对不上。选项文本干净时
  // 上面的指纹匹配能解决选择题；判断题只有「对/错」，没有区分度，于是退一步用
  // 「同一章节 + 同题型 + 同题干长度」对齐 —— 混淆只换字、不改长度，长度是可靠
  // 指纹，而且只有唯一候选才敢用。章节本身由已经命中的题确定。
  const chapterTitle = countChapter(lookups);
  const chapterEntries = chapterTitle
    ? entries.filter((entry) => entry.chapterTitle === chapterTitle)
    : [];
  const usedStems = new Set(
    lookups.flatMap((lookup) => (lookup.matchedEntries ?? []).map((entry) => entry.stem)),
  );

  const unresolved = [];
  const aligned = [];
  const positional = [];
  lookups.forEach((lookup, index) => {
    const question = questions[index];
    const optionList = optionTexts(question.options);
    if (!lookup.answer) {
      const length = canonicalStem(question.stem).length;
      // 唯一性必须看在整章里的分布，不能用「排除已用过的条目」凑出唯一 ——
      // 那样同长度的另一道题（比如两个都是 5 个字的判断题）会被错配进来。
      const sameShape = chapterEntries.filter(
        (entry) => entry.type === question.type && length > 0 && entry.canonicalLength === length,
      );
      const candidate = sameShape.length === 1 ? sameShape[0] : null;
      const alignedSelection =
        candidate && !usedStems.has(candidate.canonicalStem)
          ? alignSelection(candidate, question)
          : null;
      if (alignedSelection && candidate.verdict === VERDICT_CORRECT) {
        usedStems.add(candidate.canonicalStem);
        aligned.push(index + 1);
        if (alignedSelection.positional) {
          positional.push(index + 1);
        }
        answers.push({ index: index + 1, type: question.type, ...alignedSelection.selection });
        return;
      }

      unresolved.push({ index: index + 1, question });
      if (lookup.note) {
        notes.push(lookup.note);
      }
      diagnostics.push({
        index: index + 1,
        type: question.type,
        stem: question.stem ?? "",
        optionCount: optionList.length,
        options: optionList.slice(0, 4),
        matched: Boolean(lookup.matched),
        nearestStem: lookup.nearest?.stem ?? null,
        similarity: lookup.nearest?.similarity ?? 0,
      });
      if (!lookup.matched) {
        // 题干根本没找到：把最相近的题库题干一起报出来，才能区分「题库没收这题」
        // 和「收录了但文字有出入」——两者都只能靠改题库解决，不能放宽匹配。
        misses.push({ stem: question.stem, nearest: lookup.nearest });
      }
      for (const exclusion of lookup.exclusions) {
        exclusions.push({ index: index + 1, type: question.type, ...exclusion });
      }
    }
  });

  if (aligned.length) {
    notes.push(
      `第 ${aligned.join("、")} 题题干被平台做了字体混淆（取回的是生僻字），已按「同章节+同题型+同长度」对齐到题库「${chapterTitle}」`,
    );
  }
  if (positional.length) {
    notes.push(
      `第 ${positional.join("、")} 题连选项都被混淆，已用题干换字表验证选项顺序一致后按位置取答案`,
    );
  }

  if (misses.length) {
    // 摘要进报告，页面题干与最相近题库题干的逐字对照在诊断日志里（见 diagnostics）。
    const best = misses.reduce(
      (top, item) => ((item.nearest?.similarity ?? 0) > (top?.nearest?.similarity ?? 0) ? item : top),
      null,
    );
    const similarity = best?.nearest?.similarity ?? 0;
    notes.push(
      similarity >= NEAR_MISS_FLOOR
        ? `题库未收录 ${misses.length} 题（最相近题干相似度 ${similarity.toFixed(2)}，明细见诊断日志）`
        : `题库未收录 ${misses.length} 题（无相近题干）`,
    );
  }

  // 题型识别不出来时，同题型的比对会被整体过滤掉，相似度只剩 0 这种误导性结论，
  // 所以单独点明——它通常意味着选项选择器没抓到东西，需要校准选择器。
  const untyped = diagnostics.filter((item) => item.type === "other").length;
  if (untyped) {
    notes.push(`${untyped} 题的页面题型无法识别（选项选择器可能没抓到选项），请核对 src/platform/selectors.mjs`);
  }

  return { answers, unresolved, exclusions, notes, diagnostics };
}
