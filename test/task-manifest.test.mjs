import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTaskKind,
  extractCardId,
  isLockedLesson,
  makeTaskKey,
  selectTaskTabIndex,
} from "../src/task-manifest.mjs";

test("extractCardId reads explicit attributes and Chaoxing onclick metadata", () => {
  assert.equal(extractCardId({ "data-cardid": "1236261385" }), "1236261385");
  assert.equal(
    extractCardId({ onclick: "changeDisplay(this, 0, 1236261385)" }),
    "1236261385",
  );
  assert.equal(extractCardId({ id: "dct1", title: "视频" }), null);
});

test("classifyTaskKind keeps video, homework, and document adapters separate", () => {
  assert.equal(classifyTaskKind({ title: "视频", moduleType: "quiz" }), "video");
  assert.equal(classifyTaskKind({ title: "作业", moduleType: "video" }), "assessment");
  assert.equal(classifyTaskKind({ title: "任务", moduleType: "video" }), "video");
  assert.equal(classifyTaskKind({ title: "任务", hasInlineQuiz: true }), "assessment");
  assert.equal(classifyTaskKind({ title: "课程资料" }), "document");
  assert.equal(classifyTaskKind({ title: "讨论" }), "other");
});

test("selectTaskTabIndex prefers card identity before tab id and ordinal", () => {
  const tabs = [
    { cardId: "card-a", tabId: "dct1", ordinal: 1 },
    { cardId: "card-b", tabId: "dct2", ordinal: 2 },
  ];
  assert.equal(
    selectTaskTabIndex(tabs, { cardId: "card-b", tabId: "dct1", ordinal: 1 }),
    1,
  );
  assert.equal(selectTaskTabIndex(tabs, { tabId: "dct2", ordinal: 1 }), 1);
  assert.equal(selectTaskTabIndex(tabs, { ordinal: 1 }), 0);
  assert.equal(selectTaskTabIndex(tabs, { ordinal: 9 }), -1);
});

test("isLockedLesson recognizes the platform gate text", () => {
  assert.equal(isLockedLesson({ progressText: "需完成之前闯关任务点，该章节才能解锁" }), true);
  assert.equal(isLockedLesson({ progressText: "2个待完成任务点" }), false);
});

test("makeTaskKey prefers cardId and has a deterministic tab fallback", () => {
  assert.equal(
    makeTaskKey({ courseId: "1", clazzId: "2", knowledgeId: "3", cardId: "4", tabId: "dct9", ordinal: 9 }),
    "1:2:3:card:4",
  );
  assert.equal(
    makeTaskKey({ courseId: "1", clazzId: "2", knowledgeId: "3", tabId: "dct9", ordinal: 9 }),
    "1:2:3:tab:dct9:9",
  );
});

