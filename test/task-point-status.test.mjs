import assert from "node:assert/strict";
import test from "node:test";

import { STUDY_SELECTORS } from "../src/study-selectors.mjs";
import { parseTaskPointState, readTaskPointState } from "../src/task-point-status.mjs";

test("parses explicit incomplete aria-label as pending", () => {
  assert.equal(
    parseTaskPointState({ ariaLabel: "任务点未完成", text: "观看时长需 ≥ 总时长的 90%" }),
    "pending",
  );
});

test("parses explicit completion markers as completed", () => {
  assert.equal(parseTaskPointState({ ariaLabel: "任务点已完成" }), "completed");
  assert.equal(parseTaskPointState({ className: "ans-job-icon ans-job-icon-done" }), "completed");
});

test("unknown task-point DOM is unavailable, never completed", () => {
  assert.equal(parseTaskPointState({ text: "观看时长需 ≥ 总时长的 90%" }), "unavailable");
});

test("parser normalizes whitespace before matching state words", () => {
  assert.equal(parseTaskPointState({ ariaLabel: " 任务点  已完成 " }), "completed");
  assert.equal(
    parseTaskPointState({
      ariaLabel: "  任务点 未完成  ",
      text: " 观看时长需 ≥ 总时长的 90% ",
    }),
    "pending",
  );
});

test("explicit negative words outrank completion classes on the same element", () => {
  assert.equal(
    parseTaskPointState({
      ariaLabel: "任务点未完成",
      className: "ans-job-icon ans-job-icon-done",
    }),
    "pending",
  );
});

test("completion class words match only on token boundaries", () => {
  assert.equal(parseTaskPointState({ className: "ans-job-icon-done" }), "completed");
  assert.equal(parseTaskPointState({ className: "done" }), "completed");
  // “notdone”/“undone” 不是完成标记，不能误判为 completed。
  assert.equal(parseTaskPointState({ className: "ans-job-icon-notdone" }), "unavailable");
});

test("explicit boolean completion flag is honored conservatively", () => {
  assert.equal(parseTaskPointState({ completed: true }), "completed");
  assert.equal(parseTaskPointState({ completed: false }), "pending");
  assert.equal(parseTaskPointState({}), "unavailable");
});

test("selectors expose task-point icon, condition text, and completion candidates", () => {
  const taskPoint = STUDY_SELECTORS.taskPoint;
  assert.ok(Array.isArray(taskPoint.iconCandidates) && taskPoint.iconCandidates.length > 0);
  assert.ok(
    Array.isArray(taskPoint.conditionTextCandidates) && taskPoint.conditionTextCandidates.length > 0,
  );
  assert.ok(taskPoint.completionClassWords.includes("done"));
  assert.ok(taskPoint.completionClassWords.includes("complete"));
  assert.ok(
    Array.isArray(taskPoint.completionAttrNames) && taskPoint.completionAttrNames.length > 0,
  );
});

// ---- readTaskPointState（只读，不点击、不改播放状态）----

function fakeElement({ attributes = {}, text = "", children = {} } = {}) {
  const attributeMap = new Map(
    Object.entries(attributes).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    get id() {
      return attributeMap.get("id") ?? "";
    },
    get attributes() {
      return [...attributeMap].map(([name, value]) => ({ name, value }));
    },
    getAttribute(name) {
      return attributeMap.has(name) ? attributeMap.get(name) : null;
    },
    get textContent() {
      return text;
    },
    queryAll(selector) {
      return children[selector] ?? [];
    },
  };
}

function fakeLocator(elements) {
  const locator = {
    async count() {
      return elements.length;
    },
    first() {
      return locator;
    },
    nth(index) {
      return fakeLocator(elements.slice(index, index + 1));
    },
    locator(selector) {
      return fakeLocator(elements.flatMap((element) => element.queryAll(selector)));
    },
    async getAttribute(name) {
      return elements[0] ? elements[0].getAttribute(name) : null;
    },
    async textContent() {
      return elements[0] ? elements[0].textContent : null;
    },
    async isVisible() {
      return elements.length > 0;
    },
    async waitFor() {},
    async evaluateAll(fn) {
      return fn(elements);
    },
    // readTaskPointState 只读：任何点击都视为违规。
    async click() {
      throw new Error("readTaskPointState 不得点击或改变播放状态");
    },
  };
  return locator;
}

function fakePage(tabElements) {
  return {
    locator(selector) {
      if (selector === STUDY_SELECTORS.taskTab) {
        return fakeLocator(tabElements);
      }
      return fakeLocator([]);
    },
    async waitForTimeout() {},
  };
}

test("readTaskPointState reads pending tip text within the matched task tab", async () => {
  const icon = fakeElement({ attributes: { class: "ans-job-icon" } });
  const tip = fakeElement({
    attributes: { class: "jobUnfinish" },
    text: "任务点未完成 观看时长需 ≥ 总时长的 90%",
  });
  const tab = fakeElement({
    attributes: { id: "dct1", title: "视频", class: "cur" },
    children: { "span.ans-job-icon": [icon], ".jobUnfinish": [tip] },
  });

  const result = await readTaskPointState(fakePage([tab]), { tabId: "dct1", ordinal: 1 });

  assert.equal(result.state, "pending");
  assert.match(result.conditionText, /任务点未完成/);
  assert.match(result.conditionText, /90%/);
  assert.equal(result.source, ".jobUnfinish");
});

test("readTaskPointState reads completion from the task-point icon class", async () => {
  const icon = fakeElement({ attributes: { class: "ans-job-icon ans-job-icon-done" } });
  const tab = fakeElement({
    attributes: { id: "dct2", title: "视频 2", "data-cardid": "123456" },
    children: { "span.ans-job-icon": [icon] },
  });

  const result = await readTaskPointState(fakePage([tab]), { cardId: "123456", ordinal: 1 });

  assert.equal(result.state, "completed");
  assert.equal(result.source, "span.ans-job-icon");
});

test("readTaskPointState prefers pending when DOM evidence contradicts itself", async () => {
  const icon = fakeElement({ attributes: { class: "ans-job-icon ans-job-icon-done" } });
  const tip = fakeElement({
    attributes: { class: "jobUnfinish" },
    text: "任务点未完成",
  });
  const tab = fakeElement({
    attributes: { id: "dct1", title: "视频" },
    children: { "span.ans-job-icon": [icon], ".jobUnfinish": [tip] },
  });

  const result = await readTaskPointState(fakePage([tab]), { tabId: "dct1", ordinal: 1 });

  assert.equal(result.state, "pending");
});

test("readTaskPointState returns unavailable when the tab has no state evidence", async () => {
  const tab = fakeElement({ attributes: { id: "dct3", title: "文档" } });

  const result = await readTaskPointState(fakePage([tab]), { tabId: "dct3", ordinal: 1 });

  assert.deepEqual(result, {
    state: "unavailable",
    conditionText: "",
    source: "task-point-not-found",
  });
});

test("readTaskPointState returns unavailable when no task tab matches the identity", async () => {
  const tab = fakeElement({ attributes: { id: "dct1", title: "视频" } });

  const result = await readTaskPointState(fakePage([tab]), { tabId: "dct9", ordinal: 9 });

  assert.deepEqual(result, {
    state: "unavailable",
    conditionText: "",
    source: "task-tab-missing",
  });
});

test("readTaskPointState resolves the tab by card identity before tab id and ordinal", async () => {
  const tip = fakeElement({ attributes: { class: "jobUnfinish" }, text: "任务点未完成" });
  const first = fakeElement({ attributes: { id: "dct1", title: "视频", "data-cardid": "111" } });
  const second = fakeElement({
    attributes: { id: "dct2", title: "视频 2", "data-cardid": "222" },
    children: { ".jobUnfinish": [tip] },
  });

  const result = await readTaskPointState(
    fakePage([first, second]),
    { cardId: "222", tabId: "dct1", ordinal: 1 },
  );

  assert.equal(result.state, "pending");
  assert.equal(result.source, ".jobUnfinish");
});
