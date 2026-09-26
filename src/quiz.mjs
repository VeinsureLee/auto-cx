import { STUDY_SELECTORS } from "./study-selectors.mjs";
import { answerQuestions } from "./answerer.mjs";

const QUIZ = STUDY_SELECTORS.quiz;

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeOptionText(text) {
  return normalize(text).replace(/^(?:\([A-Za-z0-9]\)|[A-Za-z0-9][.、)）])\s*/, "");
}

export function normalizeQuestionStem(content, label = "") {
  const text = normalize(content);
  const prefix = normalize(label);
  if (prefix && text.startsWith(prefix)) {
    return text.slice(prefix.length).trim();
  }
  return text;
}

export function normalizeOptionLabel(marker, content) {
  return normalizeOptionText(`${normalize(marker)} ${normalize(content)}`);
}

// 超星题目 data 属性：0=单选 1=多选 2=填空 3=判断 4=简答
export function mapQType(code) {
  if (code === null || code === undefined || String(code).trim() === "") {
    return null;
  }
  const numeric = Number(code);
  if (numeric === 0) return "single";
  if (numeric === 1) return "multi";
  if (numeric === 2) return "fill";
  if (numeric === 3) return "judge";
  if (numeric === 4) return "essay";
  return null;
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
      return (
        Array.isArray(answer.selectedIndexes) &&
        answer.selectedIndexes.length > 0 &&
        (question.type !== "single" || answer.selectedIndexes.length === 1) &&
        answer.selectedIndexes.every(
          (selectedIndex) =>
            Number.isInteger(selectedIndex) &&
            selectedIndex >= 1 &&
            selectedIndex <= (question.options?.length ?? 0),
        )
      );
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
  return frame
    .locator(QUIZ.questionBlock)
    .evaluateAll(
      (blocks, selectors) => {
        const {
          optionSel,
          optionMark,
          optionDataAttr,
          stemSel,
          stemContentSel,
          stemLabelSel,
          stemTextSel,
          fillInputSel,
          essayTextareaSel,
        } = selectors;
        const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

        return blocks.map((block) => {
          const qtypeValue = block.getAttribute("data");
          const stemElement = block.querySelector(stemSel);
          const stemContentElement = stemElement?.querySelector(stemContentSel);
          const stemLabel = normalize(stemElement?.querySelector(stemLabelSel)?.textContent);
          const rawStem = normalize(
            stemContentElement?.textContent || stemElement?.querySelector(stemTextSel)?.textContent || stemElement?.textContent,
          );
          const stem = rawStem.startsWith(stemLabel)
            ? rawStem.slice(stemLabel.length).trim()
            : rawStem;

          const options = [];
          const optionItems = block.querySelectorAll(optionSel);
          for (const item of optionItems) {
            const mark = item.querySelector(optionMark);
            const data = mark?.getAttribute(optionDataAttr) ?? "";
            const markerText = normalize(mark?.textContent || item.querySelector("i.fl")?.textContent);
            const anchorText = normalize(item.querySelector("a.after, a")?.textContent);
            const text = normalizeOptionText(
              anchorText || item.getAttribute("aria-label") || item.textContent || "",
            );
            if (text) {
              options.push({ data, text: normalizeOptionLabel(markerText, text) });
            }
          }

          const fillInputs = Array.from(block.querySelectorAll(fillInputSel)).filter(
            (input) => input.offsetParent !== null || input.type !== "hidden",
          );
          const inputCount = fillInputs.length;
          const textareaCount = block.querySelectorAll(essayTextareaSel).length;

          const qtype =
            qtypeValue === null || qtypeValue.trim() === "" ? null : Number(qtypeValue);
          let type =
            qtype === 0
              ? "single"
              : qtype === 1
                ? "multi"
                : qtype === 2
                  ? "fill"
                  : qtype === 3
                    ? "judge"
                    : qtype === 4
                      ? "essay"
                      : null;
          if (!type) {
            if (textareaCount > 0) {
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
          }

          return {
            type,
            stem,
            options,
            inputCount,
            textareaCount,
          };
        });
      },
      {
        optionSel: QUIZ.optionItem,
        optionMark: QUIZ.optionMark,
        optionDataAttr: QUIZ.optionDataAttr,
        stemSel: QUIZ.stem,
        stemContentSel: QUIZ.stemContent,
        stemLabelSel: QUIZ.stemLabel,
        stemTextSel: QUIZ.stemText,
        fillInputSel: QUIZ.fillInput,
        essayTextareaSel: QUIZ.essayTextarea,
      },
    );
}

async function clickOption(frame, questionIndex, optionIndex) {
  const block = frame.locator(QUIZ.questionBlock).nth(questionIndex - 1);
  const options = block.locator(QUIZ.optionItem);
  const count = await options.count();
  if (optionIndex - 1 >= count) {
    return false;
  }
  const option = options.nth(optionIndex - 1);
  await option.scrollIntoViewIfNeeded();
  await option.click({ force: true }).catch(() => option.click({ force: true }));
  return true;
}

async function clickJudge(frame, questionIndex, trueFalse) {
  const block = frame.locator(QUIZ.questionBlock).nth(questionIndex - 1);
  const options = block.locator(QUIZ.optionItem);
  const count = await options.count();
  const targetData = trueFalse ? "true" : "false";
  const targetText = trueFalse ? "对" : "错";

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const data = await option
      .locator(QUIZ.optionMark)
      .getAttribute(QUIZ.optionDataAttr)
      .catch(() => null);
    const text = normalize(await option.textContent().catch(() => ""));
    if (data === targetData || normalize(text).includes(targetText)) {
      await option.scrollIntoViewIfNeeded();
      await option.click({ force: true }).catch(() => option.click({ force: true }));
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

    if ((question.type === "single" || question.type === "multi") && Array.isArray(answer.selectedIndexes)) {
      for (const optionIndex of answer.selectedIndexes) {
        await clickOption(frame, index + 1, optionIndex);
      }
      filled.push({ index: index + 1, applied: answer.selectedIndexes });
    } else if (question.type === "judge") {
      const applied = await clickJudge(frame, index + 1, answer.trueFalse);
      filled.push({ index: index + 1, applied });
    } else if (question.type === "fill") {
      const block = frame.locator(QUIZ.questionBlock).nth(index);
      const inputs = block.locator(QUIZ.fillInput).filter({ visible: true });
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

async function waitForSubmitSuccess(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 提交后作业 iframe 会跳转到“已完成/查看答案”页面，旧 frame 会失效，
    // 因此跨所有 frame 扫描成功/重答/验证码状态。
    for (const frame of page.frames()) {
      try {
        const captcha = frame.locator(QUIZ.captchaWindow);
        if ((await captcha.count().catch(() => 0)) > 0 && (await captcha.isVisible().catch(() => false))) {
          return "captcha";
        }
        const mark = frame.locator(QUIZ.successMark).first();
        if ((await mark.count().catch(() => 0)) > 0 && (await mark.isVisible().catch(() => false))) {
          return "success";
        }
        const bodyText = await frame.locator("body").textContent().catch(() => "");
        if (QUIZ.completedText.test(bodyText)) {
          return "success";
        }
        if (/重新作答|重新答题|再答一次|错误较多|需重做|未通过/.test(bodyText)) {
          return "reanswer";
        }
      } catch {
        // frame 短暂失效则继续
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function findClickableButton(frame, selector, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buttons = frame.locator(selector);
    const count = await buttons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (await button.isVisible().catch(() => false)) {
        return button;
      }
    }
    await frame.waitForTimeout(300);
  }
  return null;
}

async function findButtonAcrossFrames(page, selector, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const buttons = frame.locator(selector);
      const count = await buttons.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (await button.isVisible().catch(() => false)) {
          return button;
        }
      }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

export async function detectQuizSubmissionState(frame) {
  try {
    const captcha = frame.locator(QUIZ.captchaWindow).first();
    if ((await captcha.count().catch(() => 0)) > 0 && (await captcha.isVisible().catch(() => false))) {
      return "captcha";
    }

    const completedMarks = frame.locator(QUIZ.completedMark);
    const completedCount = await completedMarks.count().catch(() => 0);
    for (let index = 0; index < completedCount; index += 1) {
      if (await completedMarks.nth(index).isVisible().catch(() => false)) {
        return "submitted";
      }
    }

    const bodyText = normalize(await frame.locator("body").textContent().catch(() => ""));
    if (QUIZ.completedText.test(bodyText)) {
      return "submitted";
    }

    const submitButtons = frame.locator(QUIZ.submitButton);
    const submitCount = await submitButtons.count().catch(() => 0);
    for (let index = 0; index < submitCount; index += 1) {
      if (await submitButtons.nth(index).isVisible().catch(() => false)) {
        return "pending";
      }
    }
    if (QUIZ.pendingText.test(bodyText)) {
      return "pending";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function handleQuizWork({
  frame,
  page,
  config,
  dryRun,
  beforeSubmit,
  precomputedAnswers = null,
  trials = [],
}) {
  await frame
    .locator(QUIZ.questionBlock)
    .first()
    .waitFor({ state: "attached", timeout: 15_000 });

  const questions = await collectQuestions(frame);
  if (!questions.length) {
    return { status: "skipped", detail: "测验帧中未识别到题目", answers: [] };
  }

  // 允许复用已保存的答案（如 dry-run 阶段落盘的答案），不再重新调用大模型。
  let answers;
  let partial = false;
  let note = null;
  if (Array.isArray(precomputedAnswers) && precomputedAnswers.length) {
    answers = precomputedAnswers;
  } else {
    const generated = await answerQuestions(questions, config, { trials });
    answers = generated.answers;
    partial = generated.partial;
    note = generated.note;
    if (!answers.length && partial) {
      return { status: "skipped", detail: note, answers: [] };
    }
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

  const submitButton = await findClickableButton(frame, QUIZ.submitButton);
  if (!submitButton) {
    return {
      status: "error",
      detail: "未找到测验提交按钮，请人工确认",
      answers,
    };
  }

  if (typeof beforeSubmit === "function") {
    await beforeSubmit({ questions, answers });
  }
  await submitButton.click().catch(() => submitButton.click({ force: true }));

  // 提交后平台会在顶层页面弹出确认窗（workPop -> #popok “提交”），跨 frame 查找并点击。
  const confirmButton = await findButtonAcrossFrames(page, QUIZ.confirmButton, 8_000);
  if (confirmButton) {
    await confirmButton.click({ force: true }).catch(() => confirmButton.click());
  }

  const outcome = await waitForSubmitSuccess(page);
  if (outcome === "reanswer") {
    return {
      status: "error",
      detail: "答题错误较多，平台要求重新作答；将重新生成答案并重试",
      answers,
      submissionStarted: true,
      reanswer: true,
    };
  }
  if (outcome === "captcha") {
    return {
      status: "error",
      detail: "平台要求输入验证码，程序不会绕过验证码；请人工完成提交",
      answers,
      submissionStarted: true,
    };
  }
  if (outcome !== "success") {
    return {
      status: "error",
      detail: "已点击提交但未确认“提交成功”，请人工核对",
      answers,
      submissionStarted: true,
      uncertain: true,
    };
  }
  return {
    status: "answered",
    detail: `已提交 ${questions.length} 题答案`,
    answers,
    submissionStarted: true,
  };
}

// —— 视频播放中弹出的内嵌测验 ——

async function collectVideoQuizQuestions(frame) {
  return frame
    .locator(STUDY_SELECTORS.videoQuiz.item)
    .evaluateAll(
      (blocks, selectors) => {
        const { titleSel, optionSel } = selectors;
        const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

        return blocks.map((block) => {
          const stem = normalize(block.querySelector(titleSel)?.textContent);
          const options = [];
          const optionItems = block.querySelectorAll(optionSel);
          for (const item of optionItems) {
            const label = normalize(item.querySelector("label")?.textContent);
            const text = normalize(label).replace(/^(?:\([A-Za-z0-9]\)|[A-Za-z0-9][.、)）])\s*/, "");
            if (text) {
              options.push(text);
            }
          }

          const checkboxCount = block.querySelectorAll('input[type="checkbox"]').length;
          let type = "single";
          if (checkboxCount > 0) {
            type = "multi";
          } else if (
            options.length === 2 &&
            options.every((option) => /^(对|错|正确|错误|是|否)$/.test(option))
          ) {
            type = "judge";
          }

          return {
            type,
            stem,
            options,
            inputCount: 0,
            textareaCount: 0,
          };
        });
      },
      {
        titleSel: STUDY_SELECTORS.videoQuiz.itemTitle,
        optionSel: STUDY_SELECTORS.videoQuiz.optionItem,
      },
    );
}

async function clickVideoQuizOption(block, optionIndex) {
  const option = block.locator(STUDY_SELECTORS.videoQuiz.optionItem).nth(optionIndex);
  if ((await option.count()) === 0) {
    return false;
  }
  const input = option.locator('input[type="radio"], input[type="checkbox"]').first();
  if ((await input.count()) > 0) {
    await input.check({ force: true }).catch(() => input.click({ force: true }));
  } else {
    await option.scrollIntoViewIfNeeded();
    await option.click({ force: true }).catch(() => option.click({ force: true }));
  }
  return true;
}

export async function isVideoQuizVisible(frame) {
  const overlay = frame.locator(STUDY_SELECTORS.videoQuiz.overlay).first();
  if ((await overlay.count()) === 0 || !(await overlay.isVisible().catch(() => false))) {
    return false;
  }
  const item = frame.locator(STUDY_SELECTORS.videoQuiz.item).first();
  return (await item.count()) > 0;
}

async function waitForVideoQuizClosed(frame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isVideoQuizVisible(frame))) {
      return true;
    }
    await frame.waitForTimeout(300);
  }
  return false;
}

export async function handleVideoQuizWork({ frame, config }) {
  const questions = await collectVideoQuizQuestions(frame);
  if (!questions.length) {
    return { status: "skipped", detail: "未识别到视频内题目", answers: [] };
  }

  // 视频弹题通常选项少、答错可重选，直接逐个选项暴力尝试，不调用大模型。
  const answers = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const block = frame.locator(STUDY_SELECTORS.videoQuiz.item).nth(index);
    let solved = false;

    for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
      await clickVideoQuizOption(block, optionIndex);
      await frame.waitForTimeout(400);

      const submitButton = frame.locator(STUDY_SELECTORS.videoQuiz.submitButton).first();
      if ((await submitButton.count()) === 0) {
        break;
      }
      await submitButton.click({ force: true }).catch(() => submitButton.click());

      // 答对→弹题关闭、视频继续；答错→弹题停留，可继续重选。
      if (await waitForVideoQuizClosed(frame, 4_000)) {
        solved = true;
        answers.push({ index: index + 1, selectedIndexes: [optionIndex + 1] });
        break;
      }
    }

    if (!solved) {
      return {
        status: "skipped",
        detail: "视频内题目所有选项均尝试失败，未能通过",
        answers,
      };
    }
  }

  // 弹题关闭后若仍有“继续”按钮则点一下。
  const continueButton = frame.locator(STUDY_SELECTORS.videoQuiz.continueButton).first();
  if ((await continueButton.count()) > 0 && (await continueButton.isVisible().catch(() => false))) {
    await continueButton.click({ force: true }).catch(() => continueButton.click());
  }

  return { status: "answered", detail: "视频内题目已作答", answers };
}
