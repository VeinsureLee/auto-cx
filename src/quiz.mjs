import { STUDY_SELECTORS } from "./study-selectors.mjs";
import { answerQuestions } from "./answerer.mjs";

const QUIZ = STUDY_SELECTORS.quiz;

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeOptionText(text) {
  return normalize(text).replace(/^(?:\([A-Za-z0-9]\)|[A-Za-z0-9][.、)）])\s*/, "");
}

export function classifyQuestionType({ optionCount, radioCount, checkboxCount, inputCount, textareaCount, stemNotes }) {
  const joinedNotes = normalize(stemNotes);

  if (checkboxCount > 0) {
    return "multi";
  }
  if (radioCount > 0) {
    if (joinedNotes.includes("判断") || (optionCount === 2 && /对|错/.test(joinedNotes))) {
      return "judge";
    }
    return "single";
  }
  if (textareaCount > 0) {
    return "essay";
  }
  if (inputCount > 0) {
    return "fill";
  }
  if (optionCount === 2 && joinedNotes.includes("判断")) {
    return "judge";
  }
  if (optionCount > 0) {
    return "single";
  }
  return "other";
}

export function shouldSubmit(questions, answers) {
  if (!questions?.length) {
    return false;
  }
  if (questions.some((question) => question.type === "other")) {
    return false;
  }
  if (!answers?.length) {
    return false;
  }

  const answerByIndex = new Map(answers.map((answer) => [answer.index, answer]));
  return questions.every((question, index) => {
    const answer = answerByIndex.get(index + 1);
    if (!answer) {
      return false;
    }
    if (question.type === "single" || question.type === "multi") {
      return Array.isArray(answer.selectedIndexes) && answer.selectedIndexes.length > 0;
    }
    if (question.type === "judge") {
      return typeof answer.trueFalse === "boolean";
    }
    if (question.type === "fill") {
      return Boolean(answer.fillText);
    }
    if (question.type === "essay") {
      return Boolean(answer.essayText);
    }
    return false;
  });
}

export async function collectQuestions(frame) {
  return frame.locator(QUIZ.questionBlock).evaluateAll((blocks, rawSelectors) => {
    const { optionSel, optionSelAlt, fillInputSel } = rawSelectors;
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

    return blocks.map((block) => {
      const stemElement = block.querySelector(".Zy_TItleTop, .Zy_TItle, .mark_name");
      const stem = normalize(stemElement?.textContent || block.getAttribute("data") || "");
      const stemNotes = normalize(
        [...(block.querySelectorAll(".Zy_TItle, .fl, .clearfix") ?? [])]
          .map((element) => element.textContent)
          .join(" "),
      );

      const optionItems = block.querySelectorAll(`${optionSel}, ${optionSelAlt}`);
      const options = [];
      for (const item of optionItems) {
        const text = normalize(item.textContent);
        if (text && !/\b(正确答案|我的答案|得分|解析)\b/.test(text)) {
          options.push(normalize(text).replace(/^(?:\([A-Za-z0-9]\)|[A-Za-z0-9][.、)）])\s*/, ""));
        }
      }

      const radioCount = block.querySelectorAll('input[type="radio"]').length;
      const checkboxCount = block.querySelectorAll('input[type="checkbox"]').length;
      const hasCheckedInput =
        block.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')
          .length > 0;
      const fillInputs = Array.from(
        block.querySelectorAll(fillInputSel),
      ).filter((input) => input.offsetParent !== null || input.type !== "hidden");
      const inputCount = hasCheckedInput ? 0 : fillInputs.length;
      const textareaCount = block.querySelectorAll("textarea").length;

      let type;
      if (checkboxCount > 0) {
        type = "multi";
      } else if (radioCount > 0) {
        type = /判断/.test(stem) || (options.length === 2 && /对|错/.test(stemNotes)) ? "judge" : "single";
      } else if (textareaCount > 0) {
        type = "essay";
      } else if (inputCount > 0) {
        type = "fill";
      } else if (options.length === 2 && /判断/.test(stem)) {
        type = "judge";
      } else if (options.length > 0) {
        type = "single";
      } else {
        type = "other";
      }

      return { type, stem, options, inputCount, textareaCount };
    });
  }, {
    optionSel: QUIZ.optionItem,
    optionSelAlt: QUIZ.optionItemAlt,
    fillInputSel: QUIZ.fillInput,
  });
}

async function clickOption(frame, questionIndex, optionIndex) {
  const block = frame.locator(QUIZ.questionBlock).nth(questionIndex - 1);
  const options = block.locator(`${QUIZ.optionItem}, ${QUIZ.optionItemAlt}`);
  const count = await options.count();
  if (optionIndex - 1 >= count) {
    return false;
  }
  const option = options.nth(optionIndex - 1);
  await option.scrollIntoViewIfNeeded();
  const input = option.locator("input").first();
  if ((await input.count()) > 0) {
    await input.check({ force: true }).catch(() => option.click());
  } else {
    await option.click();
  }
  return true;
}

async function clickJudge(frame, questionIndex, trueFalse) {
  const block = frame.locator(QUIZ.questionBlock).nth(questionIndex - 1);
  const options = block.locator(`${QUIZ.optionItem}, ${QUIZ.optionItemAlt}`);
  const count = await options.count();
  const target = trueFalse ? "对" : "错";
  for (let index = 0; index < count; index += 1) {
    const text = await options.nth(index).textContent().catch(() => "");
    if (normalize(text).includes(target)) {
      const input = options.nth(index).locator("input").first();
      if ((await input.count()) > 0) {
        await input.check({ force: true }).catch(() => options.nth(index).click());
      } else {
        await options.nth(index).click();
      }
      return true;
    }
  }
  return false;
}

export async function fillAnswers(frame, questions, answers) {
  const answerByIndex = new Map(answers.map((answer) => [answer.index, answer]));
  const filled = [];

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const answer = answerByIndex.get(index + 1);
    if (!answer) {
      continue;
    }

    if (question.type === "single" && Array.isArray(answer.selectedIndexes)) {
      for (const optionIndex of answer.selectedIndexes) {
        await clickOption(frame, index + 1, optionIndex);
      }
      filled.push({ index: index + 1, applied: answer.selectedIndexes });
    } else if (question.type === "multi" && Array.isArray(answer.selectedIndexes)) {
      for (const optionIndex of answer.selectedIndexes) {
        await clickOption(frame, index + 1, optionIndex);
      }
      filled.push({ index: index + 1, applied: answer.selectedIndexes });
    } else if (question.type === "judge") {
      const applied = await clickJudge(frame, index + 1, answer.trueFalse);
      filled.push({ index: index + 1, applied });
    } else if (question.type === "fill") {
      const block = frame.locator(QUIZ.questionBlock).nth(index);
      const inputs = block.locator(QUIZ.fillInput).filter({
        visible: true,
      });
      const parts = String(answer.fillText).split(/[；;]/).map((part) => part.trim());
      const inputCount = await inputs.count();
      for (let inputIndex = 0; inputIndex < inputCount; inputIndex += 1) {
        const value = parts[inputIndex] ?? parts[0] ?? "";
        await inputs.nth(inputIndex).fill(value);
      }
      filled.push({ index: index + 1, applied: true });
    } else if (question.type === "essay") {
      const block = frame.locator(QUIZ.questionBlock).nth(index);
      const textarea = block.locator(QUIZ.essayTextarea).first();
      await textarea.fill(answer.essayText);
      filled.push({ index: index + 1, applied: true });
    }
  }

  return filled;
}

async function waitForSubmitSuccess(frame, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mark = frame.locator(QUIZ.successMark).first();
    if ((await mark.count()) > 0 && (await mark.isVisible().catch(() => false))) {
      return true;
    }
    const bodyText = await frame.locator("body").textContent().catch(() => "");
    if (bodyText.includes(QUIZ.successText)) {
      return true;
    }
    await frame.waitForTimeout(500);
  }
  return false;
}

async function findSubmitButton(frame) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const selector of QUIZ.submitButton.split(",").map((value) => value.trim())) {
      const button = frame.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isVisible())) {
        return button;
      }
    }
    await frame.waitForTimeout(300);
  }
  return null;
}

export async function handleQuizWork({ frame, config, dryRun }) {
  await frame.locator(QUIZ.questionBlock).first().waitFor({ state: "attached", timeout: 15_000 });

  const questions = await collectQuestions(frame);
  if (!questions.length) {
    return { status: "skipped", detail: "测验帧中未识别到题目", answers: [] };
  }

  const { answers, partial, note } = await answerQuestions(questions, config);
  if (!answers.length && partial) {
    return { status: "skipped", detail: note, answers: [] };
  }

  await fillAnswers(frame, questions, answers);

  if (dryRun) {
    const unanswered = questions
      .map((_, index) => index + 1)
      .filter((index) => !answers.some((answer) => answer.index === index));
    return {
      status: "dry-run",
      detail: `已填入 ${answers.length}/${questions.length} 题答案，未提交；${unanswered.length ? `未作答：${unanswered.join("、")}` : "全部有答案"}`,
      answers,
    };
  }

  if (!shouldSubmit(questions, answers)) {
    return {
      status: "skipped",
      detail: partial ? `部分题目未获得答案（${note}），未提交` : "存在无法自动作答的题型，未提交",
      answers,
    };
  }

  const submitButton = await findSubmitButton(frame);
  if (!submitButton) {
    return {
      status: "error",
      detail: "未找到测验提交按钮，请人工确认",
      answers,
    };
  }

  const page = frame.page();
  const dialogHandler = (dialog) => dialog.accept().catch(() => {});
  page.on("dialog", dialogHandler);
  try {
    await submitButton.click();
    const confirmed = await waitForSubmitSuccess(frame);
    if (!confirmed) {
      return {
        status: "error",
        detail: "已点击提交但未确认“提交成功”，请人工核对",
        answers,
      };
    }
    return { status: "answered", detail: `已提交 ${questions.length} 题答案`, answers };
  } finally {
    page.off("dialog", dialogHandler);
  }
}