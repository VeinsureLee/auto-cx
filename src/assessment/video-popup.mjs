import { STUDY_SELECTORS } from "../platform/selectors.mjs";

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
