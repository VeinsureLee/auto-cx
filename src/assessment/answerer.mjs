import { resolveBankAnswers } from "./question-bank.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;

export function buildPrompt(questions, trials = []) {
  const lines = [
    "你是这门课程的学习助教。下面给出一些章节测验题目，请逐题给出答案。",
    "要求：只输出一个 JSON 数组，不要输出任何解释或标点外的文字。数组元素格式：",
    '[{"index": 题号(从1起), "type": "single|multi|judge|fill|essay", "selectedIndexes": [选中的选项序号], "trueFalse": true|false, "fillText": "填空内容", "essayText": "简答内容"}]',
    "规则：",
    "- single 单选 / multi 多选：selectedIndexes 为选项序号数组（1开始）；multi 至少选一个。",
    "- judge 判断：trueFalse 用 true/false 表示 对/错。",
    "- fill 填空：fillText 填完整答案；若有多个空用中文分号“；”分隔。",
    "- essay 简答：essayText 给一段通顺、切题的答案，100-200字。",
    "- 与本类题型无关的字段一律置 null。",
  ];
  if (Array.isArray(trials) && trials.length) {
    lines.push(
      "重要：下面是你之前给出、但已被系统判定为错误的答案组合，请务必给出与它们不同的答案：",
    );
    trials.forEach((trial, index) => {
      lines.push(`  错误尝试 ${index + 1}：${JSON.stringify(trial)}`);
    });
  }
  lines.push("以下是题目：");

  questions.forEach((question, index) => {
    lines.push(
      `${index + 1}. [${question.type}] ${question.stem}`,
      ...(question.options?.length
        ? question.options.map((option, optionIndex) => {
            const optionText =
              typeof option === "string" ? option : option?.text ?? String(option?.data ?? "");
            return `   ${optionIndex + 1}. ${optionText}`;
          })
        : ["   （无选项，需填写）"]),
    );
  });

  return lines.join("\n");
}

export function stripCodeFences(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function parseLlmJson(text) {
  const cleaned = stripCodeFences(text);

  const start = cleaned.search(/[[{]/);
  if (start === -1) {
    return null;
  }

  const slice = cleaned.slice(start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < slice.length; index += 1) {
    const char = slice[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(slice.slice(0, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}

export async function callChatCompletions(prompt, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const endpoint = `${config.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.deepseekApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [
          {
            role: "system",
            content: "你是课程助教，严格按要求输出 JSON 答案数组。",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, note: `DeepSeek 接口返回 HTTP ${response.status}` };
    }

    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return { ok: false, note: "DeepSeek 未返回文本内容" };
    }
    return { ok: true, content };
  } catch (error) {
    return {
      ok: false,
      note: `DeepSeek 调用失败：${error.message ?? String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeAnswer(answer) {
  if (!answer || typeof answer !== "object") {
    return null;
  }
  const index = Number(answer.index);
  if (!Number.isInteger(index) || index < 1) {
    return null;
  }

  const type = String(answer.type ?? "").toLowerCase();
  const base = { index, type };

  if (type === "single" || type === "multi") {
    const selected = Array.isArray(answer.selectedIndexes)
      ? answer.selectedIndexes
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 1)
      : [];
    if (selected.length === 0) {
      return null;
    }
    return { ...base, selectedIndexes: [...new Set(selected)] };
  }

  if (type === "judge") {
    if (typeof answer.trueFalse !== "boolean") {
      return null;
    }
    return { ...base, trueFalse: answer.trueFalse };
  }

  if (type === "fill") {
    const text = String(answer.fillText ?? "").trim();
    if (!text) {
      return null;
    }
    return { ...base, fillText: text };
  }

  if (type === "essay") {
    const text = String(answer.essayText ?? "").trim();
    if (!text) {
      return null;
    }
    return { ...base, essayText: text };
  }

  return null;
}

// 解析模型返回的答案文本；无法解析时返回 null（区别于「解析成功但没有合法答案」）。
function extractAnswers(content) {
  let parsed = parseLlmJson(content);
  if (!Array.isArray(parsed)) {
    if (parsed && typeof parsed === "object") {
      parsed = Array.isArray(parsed.answers) ? parsed.answers : [parsed];
    } else {
      return null;
    }
  }
  return parsed.map(normalizeAnswer).filter(Boolean);
}

function answersByIndex(answers) {
  const indexed = new Map();
  for (const answer of Array.isArray(answers) ? answers : []) {
    const index = Number(answer?.index);
    if (Number.isInteger(index) && index >= 1 && !indexed.has(index)) {
      indexed.set(index, answer);
    }
  }
  return indexed;
}

// 试错表里的题号是完整数组下标，而发给模型的题目子集会被重新编号成 1..k。
// 必须同步重映射、并丢弃引用了子集之外题目的条目，否则模型会照着原始题号
// 作答，指到 prompt 里根本没出现过的题目上。
function remapTrials(trials, positionByIndex) {
  const remapOne = (answer) => {
    const position = positionByIndex.get(Number(answer?.index));
    return position ? { ...answer, index: position } : null;
  };
  const remapped = [];
  for (const trial of Array.isArray(trials) ? trials : []) {
    if (Array.isArray(trial)) {
      const group = trial.map(remapOne).filter(Boolean);
      if (group.length) {
        remapped.push(group);
      }
      continue;
    }
    const item = remapOne(trial);
    if (item) {
      remapped.push(item);
    }
  }
  return remapped;
}

export async function answerQuestions(
  questions,
  config,
  { trials = [], fallbackAnswers = null, questionBank = null } = {},
) {
  if (!questions?.length) {
    return { answers: [], partial: false, note: "没有需要作答的题目" };
  }

  // 本地题库优先：判定为 100% 正确、且没被平台判错过的题目直接照抄，不再询问模型。
  const banked = resolveBankAnswers(questions, questionBank ?? [], { trials });
  const answers = [...banked.answers];
  const notes = [];
  if (banked.answers.length) {
    notes.push(`题库命中 ${banked.answers.length}/${questions.length} 题`);
  }
  if (banked.exclusions.length) {
    notes.push(`已排除题库作答未满分的答案 ${banked.exclusions.length} 题`);
  }
  for (const note of new Set(banked.notes)) {
    notes.push(note);
  }

  // 题库没覆盖的题目先复用上次保存的答案（如 dry-run 落盘的答案），剩下的才问模型。
  const saved = answersByIndex(fallbackAnswers);
  const pending = [];
  for (const item of banked.unresolved) {
    const previous = saved.get(item.index);
    if (previous) {
      answers.push(previous);
      continue;
    }
    pending.push(item);
  }
  const reused = banked.unresolved.length - pending.length;
  if (reused) {
    notes.push(`复用上次答案 ${reused} 题`);
  }
  if (pending.length) {
    notes.push(`模型作答 ${pending.length} 题`);
  }

  if (pending.length) {
    // 只把题库未覆盖的题目发给模型，因此返回的下标需要映射回原始题号；
    // 试错表也要换算成子集内的编号。
    const positionByIndex = new Map(pending.map((item, position) => [item.index, position + 1]));
    const result = await callChatCompletions(
      buildPrompt(
        pending.map((item) => item.question),
        remapTrials([...(Array.isArray(trials) ? trials : []), ...banked.exclusions], positionByIndex),
      ),
      config,
    );

    if (!result.ok) {
      notes.push(result.note);
    } else {
      const extracted = extractAnswers(result.content);
      if (extracted === null) {
        notes.push("无法解析 AI 返回的答案 JSON");
      } else {
        const remapped = extracted
          .map((answer) => {
            const target = pending[answer.index - 1];
            return target ? { ...answer, index: target.index } : null;
          })
          .filter(Boolean);
        answers.push(...remapped);
        if (extracted.length > remapped.length) {
          notes.push(`模型返回了 ${extracted.length - remapped.length} 条越界答案，已丢弃`);
        }
      }
    }
  }

  const answeredIndexes = new Set(answers.map((answer) => answer.index));
  const missing = questions
    .map((question, index) => index + 1)
    .filter((index) => !answeredIndexes.has(index));
  const partial = missing.length > 0;
  if (partial) {
    notes.push(`仍有 ${missing.join("、")} 题未获得答案`);
  }

  return {
    answers: [...answers].sort((left, right) => left.index - right.index),
    partial,
    note: notes.join("；") || null,
    diagnostics: banked.diagnostics,
  };
}
