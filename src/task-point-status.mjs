// 任务点完成状态解析：保守解析“已完成 / 未完成 / 无法判定”。
// 原则：宁可 unavailable 也绝不误报 completed；显式否定词优先于一切完成标记。

import { STUDY_SELECTORS } from "./study-selectors.mjs";
import { extractCardId, readTaskTabs, selectTaskTabIndex } from "./task-manifest.mjs";

const PENDING_WORDS = /未完成|未达成|待完成/;
// 仅接受明确指向任务点的完成语义；“完成条件”只是条件描述，不是完成状态。
const COMPLETED_WORDS = /(?:任务点\s*已完成|已完成\s*任务点|任务点\s*已达成|已达成\s*任务点)/;
const COMPLETION_CLASS_WORDS = ["done", "complete", "finished", "clear"];
const COMPLETED_ATTR_TRUE = /^(?:true|1|yes|done)$/i;
const COMPLETED_ATTR_FALSE = /^(?:false|0|no|undone)$/i;

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCompletionClassWord(className, words) {
  const normalized = normalize(className).toLowerCase();
  if (!normalized) {
    return false;
  }
  return words.some((word) =>
    new RegExp(`(^|[^a-z])${escapeRegExp(word)}([^a-z]|$)`).test(normalized),
  );
}

function parseBooleanAttr(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = normalize(value);
  if (COMPLETED_ATTR_TRUE.test(normalized)) {
    return true;
  }
  if (COMPLETED_ATTR_FALSE.test(normalized)) {
    return false;
  }
  return null;
}

function readCompletedFlag(attributes, attrNames) {
  for (const name of attrNames ?? []) {
    const parsed = parseBooleanAttr(attributes?.[name]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export function parseTaskPointState(input) {
  const { ariaLabel, text, className, completed } = input ?? {};
  const searchable = `${normalize(ariaLabel)} ${normalize(text)}`.trim();

  // 显式否定词优先：“未完成”包含“完成”，必须先判否定再判肯定。
  if (PENDING_WORDS.test(searchable)) {
    return "pending";
  }
  // 显式布尔标志与否定词同级：明确未完成时不得被完成类名/肯定词覆盖。
  if (completed === false) {
    return "pending";
  }
  if (completed === true) {
    return "completed";
  }
  if (COMPLETED_WORDS.test(searchable)) {
    return "completed";
  }
  const completionClassWords =
    STUDY_SELECTORS.taskPoint?.completionClassWords ?? COMPLETION_CLASS_WORDS;
  if (hasCompletionClassWord(className, completionClassWords)) {
    return "completed";
  }
  return "unavailable";
}

async function readCompletedFlagFromLocator(locator, attrNames) {
  for (const name of attrNames ?? []) {
    const parsed = parseBooleanAttr(await locator.getAttribute(name).catch(() => null));
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

async function readElementSignals(locator, attrNames) {
  const ariaLabel = await locator.getAttribute("aria-label").catch(() => null);
  const className = await locator.getAttribute("class").catch(() => null);
  const title = await locator.getAttribute("title").catch(() => null);
  const textContent = await locator.textContent().catch(() => null);
  const text = [title, textContent].map(normalize).filter(Boolean).join(" ") || null;
  return {
    ariaLabel,
    className,
    text,
    completed: await readCompletedFlagFromLocator(locator, attrNames),
  };
}

function toResult(candidate, state) {
  const conditionText =
    [candidate.text, candidate.ariaLabel].map(normalize).filter(Boolean).join(" ") || "";
  return { state, conditionText, source: candidate.source };
}

// 只读取与目标任务标签相关的任务点 DOM，不点击、不触碰媒体时间。
export async function readTaskPointState(page, task, selectors = STUDY_SELECTORS) {
  const taskPointSelectors = selectors?.taskPoint ?? STUDY_SELECTORS.taskPoint;
  const taskTabSelector = selectors?.taskTab ?? STUDY_SELECTORS.taskTab;

  const tabs = await readTaskTabs(page);
  const withIdentity = tabs.map((tab) => ({ ...tab, cardId: extractCardId(tab.attributes) }));
  const index = selectTaskTabIndex(withIdentity, task ?? {});
  if (index < 0) {
    return { state: "unavailable", conditionText: "", source: "task-tab-missing" };
  }

  const matchedTab = withIdentity[index];
  const tabLocator = page.locator(taskTabSelector).nth(index);
  const candidates = [
    {
      source: "task-tab",
      ariaLabel: matchedTab.attributes?.["aria-label"] ?? null,
      className: matchedTab.attributes?.class ?? null,
      text: matchedTab.title ?? null,
      completed: readCompletedFlag(matchedTab.attributes, taskPointSelectors.completionAttrNames),
    },
  ];

  for (const selector of [
    ...(taskPointSelectors.iconCandidates ?? []),
    ...(taskPointSelectors.conditionTextCandidates ?? []),
  ]) {
    const found = tabLocator.locator(selector);
    const count = await found.count().catch(() => 0);
    for (let position = 0; position < count; position += 1) {
      const signals = await readElementSignals(found.nth(position), taskPointSelectors.completionAttrNames);
      candidates.push({ ...signals, source: selector });
    }
  }

  const results = candidates.map((candidate) => ({
    candidate,
    state: parseTaskPointState(candidate),
  }));
  // 保守合并：任一候选元素给出显式否定即 pending，否则首个 completed，否则 unavailable。
  const pending = results.find((result) => result.state === "pending");
  if (pending) {
    return toResult(pending.candidate, "pending");
  }
  const completed = results.find((result) => result.state === "completed");
  if (completed) {
    return toResult(completed.candidate, "completed");
  }
  return { state: "unavailable", conditionText: "", source: "task-point-not-found" };
}
