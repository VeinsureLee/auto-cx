# Concurrent Lesson Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow one `study` command to run up to three unlocked lessons in parallel pages while rendering one live progress bar per page in a unified terminal display.

**Architecture:** Keep one Chromium browser context and process courses sequentially. For the active course, a lock-aware dynamic worker pool assigns unlocked lessons to independent Playwright pages, serializes memo mutations, and reports lifecycle/media events to one terminal progress controller.

**Tech Stack:** Node.js 20+, ECMAScript modules, Playwright Core, `node:test`, ANSI terminal control sequences, existing atomic JSON/Markdown persistence.

**Spec:** `docs/superpowers/specs/2026-09-26-concurrent-lesson-playback-design.md`

## Global Constraints

- `--concurrency` and `CHAOXING_STUDY_CONCURRENCY` accept integers from 1 through 3; default is 1 and CLI overrides environment configuration.
- One browser context is shared, but each active lesson owns a distinct Playwright `Page`.
- Courses remain sequential; concurrency applies only within the active course.
- Never dispatch a lesson whose refreshed catalog entry is locked.
- Do not seek, drag playback progress, fake focus, or bypass captchas/lesson gates.
- Do not add runtime dependencies; retain Node.js `>=20`.
- Existing report schema and memo schema remain version 1.
- `--phase video`, `--phase homework`, `--dry-run`, and all existing `--lesson` forms retain their semantics.

---

## File Structure

- Create `src/study-progress.mjs`: progress state, bar/time formatting, TTY redraw, non-TTY milestone logs, cursor cleanup.
- Create `src/study-scheduler.mjs`: lesson eligibility selection and generic dynamic worker-pool scheduling.
- Create `test/study-progress.test.mjs`: deterministic renderer and non-TTY behavior tests.
- Create `test/study-scheduler.test.mjs`: concurrency, dynamic refill, failure isolation, and lock filtering tests.
- Modify `src/config.mjs`: environment-level study concurrency.
- Modify `src/study-cli.mjs`: CLI concurrency parsing and propagation.
- Modify `src/study-memo.mjs`: serialize asynchronous mutations.
- Modify `src/study.mjs`: lifecycle events and concurrent page orchestration.
- Modify `src/video-runner.mjs`: expose video quiz handling phase before and after handling.
- Modify `test/config.test.mjs`, `test/study-cli.test.mjs`, `test/study-memo.test.mjs`, and `test/study.test.mjs`: regression and interface coverage.
- Modify `.env.example` and `README.md`: document defaults, limits, syntax, progress display, and lock-aware behavior.

---

### Task 1: Add validated study-concurrency configuration and CLI parsing

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/study-cli.mjs`
- Modify: `test/config.test.mjs`
- Modify: `test/study-cli.test.mjs`

**Interfaces:**
- Produces: `config.studyConcurrency: number` in the inclusive range 1–3.
- Produces: `collectConcurrencyArg(argv: string[], fallback: number): number`.
- Changes: `runStudy({ ..., concurrency })` receives the resolved CLI value in a later task.

- [ ] **Step 1: Write failing configuration tests**

Add to `test/config.test.mjs`:

```js
test("readConfig defaults study concurrency to one", () => {
  const config = readConfig({}, "C:\\workspace", { requireCredentials: false });
  assert.equal(config.studyConcurrency, 1);
});

test("readConfig accepts study concurrency up to three", () => {
  const config = readConfig(
    { CHAOXING_STUDY_CONCURRENCY: "3" },
    "C:\\workspace",
    { requireCredentials: false },
  );
  assert.equal(config.studyConcurrency, 3);
});

test("readConfig rejects study concurrency outside one through three", () => {
  assert.throws(
    () => readConfig({ CHAOXING_STUDY_CONCURRENCY: "0" }, process.cwd(), { requireCredentials: false }),
    /CHAOXING_STUDY_CONCURRENCY 必须是 1 到 3/,
  );
  assert.throws(
    () => readConfig({ CHAOXING_STUDY_CONCURRENCY: "4" }, process.cwd(), { requireCredentials: false }),
    /CHAOXING_STUDY_CONCURRENCY 必须是 1 到 3/,
  );
});
```

- [ ] **Step 2: Write failing CLI parser tests**

Change the import in `test/study-cli.test.mjs` to include `collectConcurrencyArg`, then add:

```js
test("collectConcurrencyArg uses the configured fallback and accepts one through three", () => {
  assert.equal(collectConcurrencyArg(["node", "study-cli.mjs"], 1), 1);
  assert.equal(collectConcurrencyArg(["--concurrency", "1"], 3), 1);
  assert.equal(collectConcurrencyArg(["--concurrency", "3"], 1), 3);
});

test("collectConcurrencyArg rejects missing, repeated, and invalid values", () => {
  assert.throws(() => collectConcurrencyArg(["--concurrency"], 1), /需要一个值/);
  assert.throws(() => collectConcurrencyArg(["--concurrency", "2.5"], 1), /1 到 3/);
  assert.throws(() => collectConcurrencyArg(["--concurrency", "4"], 1), /1 到 3/);
  assert.throws(
    () => collectConcurrencyArg(["--concurrency", "2", "--concurrency", "3"], 1),
    /只能指定一次/,
  );
});
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
node --test test/config.test.mjs test/study-cli.test.mjs
```

Expected: FAIL because `studyConcurrency` and `collectConcurrencyArg` do not exist.

- [ ] **Step 4: Implement environment and CLI validation**

In `src/config.mjs`, add `DEFAULT_STUDY_CONCURRENCY = 1` and return:

```js
studyConcurrency: parseIntegerInRange(
  env.CHAOXING_STUDY_CONCURRENCY,
  DEFAULT_STUDY_CONCURRENCY,
  1,
  3,
  "CHAOXING_STUDY_CONCURRENCY",
),
```

In `src/study-cli.mjs`, export:

```js
export function collectConcurrencyArg(argv, fallback = 1) {
  const indexes = argv
    .map((value, index) => (value === "--concurrency" ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return fallback;
  if (indexes.length > 1) throw new Error("--concurrency 只能指定一次。");
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error("--concurrency 需要一个值。");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error("--concurrency 必须是 1 到 3 之间的整数。");
  }
  return parsed;
}
```

After reading configuration in `main`, resolve `const concurrency = collectConcurrencyArg(process.argv, config.studyConcurrency)`, print `课节并发数：${concurrency}`, and pass it to `runStudy`.

- [ ] **Step 5: Run focused tests and verify success**

Run:

```bash
node --test test/config.test.mjs test/study-cli.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.mjs src/study-cli.mjs test/config.test.mjs test/study-cli.test.mjs
git commit -m "feat: validate study lesson concurrency"
```

---

### Task 2: Build the unified terminal progress controller

**Files:**
- Create: `src/study-progress.mjs`
- Create: `test/study-progress.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `formatMediaTime(seconds: number | null): string`.
- Produces: `formatProgressBar(current: number, target: number, width?: number): { percent: number, text: string }`.
- Produces: `StudyProgress` with methods `startCourse`, `assign`, `stage`, `video`, `finish`, `release`, `log`, `warn`, and `stop`.
- `StudyProgress` constructor accepts `{ stream = process.stdout, errorStream = process.stderr, redrawIntervalMs = 100 }` for deterministic tests.

- [ ] **Step 1: Write formatter tests**

Create `test/study-progress.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  StudyProgress,
  formatMediaTime,
  formatProgressBar,
} from "../src/study-progress.mjs";

test("formatMediaTime renders finite media seconds", () => {
  assert.equal(formatMediaTime(0), "00:00");
  assert.equal(formatMediaTime(65.8), "01:05");
  assert.equal(formatMediaTime(3_661), "1:01:01");
  assert.equal(formatMediaTime(null), "--:--");
});

test("formatProgressBar clamps target progress and keeps a fixed width", () => {
  assert.deepEqual(formatProgressBar(47.5, 95, 10), {
    percent: 50,
    text: "[█████░░░░░]",
  });
  assert.deepEqual(formatProgressBar(100, 95, 10), {
    percent: 100,
    text: "[██████████]",
  });
  assert.deepEqual(formatProgressBar(-5, 95, 10), {
    percent: 0,
    text: "[░░░░░░░░░░]",
  });
});
```

- [ ] **Step 2: Write TTY and non-TTY behavior tests**

Append to `test/study-progress.test.mjs`:

```js
function memoryStream(isTTY) {
  let output = "";
  return {
    isTTY,
    columns: 120,
    write(chunk) {
      output += String(chunk);
      return true;
    },
    output: () => output,
  };
}

test("StudyProgress renders one labeled progress row per active page in a TTY", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "科研诚信", total: 3, concurrency: 3 });
  progress.assign(1, { lessonTitle: "1.1 第一节" });
  progress.assign(2, { lessonTitle: "1.2 第二节" });
  progress.stage(1, { name: "video", taskTitle: "视频 1" });
  progress.video(1, { currentTime: 47.5, duration: 100, targetSeconds: 95, speed: 2 });
  progress.stage(2, { name: "homework", detail: "正在生成答案" });
  progress.stop();

  assert.match(stream.output(), /页面 1/);
  assert.match(stream.output(), /1\.1 第一节/);
  assert.match(stream.output(), /50%/);
  assert.match(stream.output(), /页面 2/);
  assert.match(stream.output(), /正在生成答案/);
});

test("StudyProgress emits only new ten-percent milestones outside a TTY", () => {
  const stream = memoryStream(false);
  const progress = new StudyProgress({ stream, errorStream: stream });
  progress.startCourse({ name: "科研诚信", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "1.1 第一节" });
  progress.video(1, { currentTime: 5, duration: 100, targetSeconds: 95, speed: 2 });
  progress.video(1, { currentTime: 9, duration: 100, targetSeconds: 95, speed: 2 });
  progress.video(1, { currentTime: 10, duration: 100, targetSeconds: 95, speed: 2 });
  progress.video(1, { currentTime: 11, duration: 100, targetSeconds: 95, speed: 2 });
  progress.stop();

  const milestones = stream.output().match(/视频进度/g) ?? [];
  assert.equal(milestones.length, 2); // initial 0% bucket and the first 10% bucket
  assert.doesNotMatch(stream.output(), /\u001b\[/);
});
```

- [ ] **Step 3: Run the new test and verify failure**

Run:

```bash
node --test test/study-progress.test.mjs
```

Expected: FAIL with module-not-found for `src/study-progress.mjs`.

- [ ] **Step 4: Implement formatter and controller**

Create `src/study-progress.mjs` with an in-memory `Map<number, WorkerState>`. Use this public state shape:

```js
{
  lessonTitle: "1.1 第一节",
  stage: "video",
  taskTitle: "视频 1",
  detail: null,
  currentTime: 47.5,
  duration: 100,
  targetSeconds: 95,
  speed: 2,
  status: "running",
  lastMilestone: 50,
}
```

Implement progress calculation as:

```js
const ratio = Number.isFinite(target) && target > 0 ? current / target : 0;
const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
const filled = Math.round((percent / 100) * width);
```

TTY rendering must include the course summary and slots from 1 through the configured concurrency. `finish(slot, { status: "done" })` increments the course's completed count once for that assignment; failed and locked outcomes do not increment it. Before the first redraw write `\u001b[?25l`; before each later redraw move up by the previous rendered line count and clear each line with `\u001b[2K`; `stop()` performs a final redraw, writes `\u001b[?25h`, and is idempotent. `log()` writes through `stream`; `warn()` performs the same safe clear/write/redraw sequence through `errorStream`.

Non-TTY `video()` writes only when `Math.floor(percent / 10) * 10` exceeds the slot's previous milestone. `assign`, stage changes, `finish`, `log`, and `stop` each produce ordinary newline-terminated text without ANSI escapes.

- [ ] **Step 5: Add the new file to syntax checking**

Insert `node --check src/study-progress.mjs` in the `check` script in `package.json`.

- [ ] **Step 6: Run tests and syntax checks**

Run:

```bash
node --test test/study-progress.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/study-progress.mjs test/study-progress.test.mjs package.json
git commit -m "feat: add unified study progress display"
```

---

### Task 3: Serialize concurrent study-memo mutations

**Files:**
- Modify: `src/study-memo.mjs`
- Modify: `test/study-memo.test.mjs`

**Interfaces:**
- Keeps: `await store.mutate(updater)` call sites unchanged.
- Guarantees: each updater and its `save()` finish before the next updater begins.
- Guarantees: one rejected updater does not poison the queue for later mutations.

- [ ] **Step 1: Write a failing concurrency test**

Append to `test/study-memo.test.mjs`:

```js
test("StudyMemoStore serializes concurrent mutations without losing updates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "study-memo-queue-"));
  const filePath = path.join(directory, "memo.json");
  const markdownPath = path.join(directory, "memo.md");
  const course = { courseId: "1", clazzId: "2", name: "课程", url: "https://example.test" };
  const store = await StudyMemoStore.open({ filePath, markdownPath, courses: [course] });
  await store.mutate((state) => refreshCatalog(state, course, [
    catalogLesson({ knowledgeId: "a", ordinal: 1 }),
    catalogLesson({ knowledgeId: "b", ordinal: 2 }),
  ]));

  const order = [];
  await Promise.all([
    store.mutate(async (state) => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      setLessonVideo(state, course, { knowledgeId: "a" }, { status: "done" });
      order.push("a:end");
    }),
    store.mutate(async (state) => {
      order.push("b:start");
      setLessonVideo(state, course, { knowledgeId: "b" }, { status: "done" });
      order.push("b:end");
    }),
  ]);

  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  const persisted = await readStudyMemo(filePath);
  assert.deepEqual(persisted.courses[0].lessons.map((lesson) => lesson.video.status), ["done", "done"]);
});
```

Keep the existing default `os` import, add `readStudyMemo` to the memo-module imports, use `os.tmpdir()` in both new tests, and wrap each temporary directory body in `try/finally` with `rm(directory, { recursive: true, force: true })` so the tests leave no files behind.

- [ ] **Step 2: Write a failing queue-recovery test**

Append:

```js
test("StudyMemoStore continues after a rejected mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "study-memo-recovery-"));
  const filePath = path.join(directory, "memo.json");
  const store = await StudyMemoStore.open({ filePath, courses: [] });

  await assert.rejects(store.mutate(async () => {
    throw new Error("expected mutation failure");
  }), /expected mutation failure/);
  await store.mutate((state) => {
    state.selection.courseQueries = ["仍可写入"];
  });

  assert.deepEqual((await readStudyMemo(filePath)).selection.courseQueries, ["仍可写入"]);
});
```

- [ ] **Step 3: Run the focused test and verify failure**

Run:

```bash
node --test test/study-memo.test.mjs
```

Expected: the ordering assertion FAILS because current mutations overlap.

- [ ] **Step 4: Implement a per-store Promise queue**

In the constructor initialize:

```js
this.mutationQueue = Promise.resolve();
```

Replace `mutate` with:

```js
mutate(updater) {
  const operation = this.mutationQueue.then(async () => {
    const result = await updater(this.state);
    await this.save();
    return result;
  });
  this.mutationQueue = operation.catch(() => {});
  return operation;
}
```

This queues the updater itself, not only the disk write, so later updates cannot mutate the same object while an earlier save is in progress.

- [ ] **Step 5: Run memo and full tests**

Run:

```bash
node --test test/study-memo.test.mjs
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/study-memo.mjs test/study-memo.test.mjs
git commit -m "fix: serialize concurrent study memo updates"
```

---

### Task 4: Extract lock-aware eligibility and implement a dynamic worker pool

**Files:**
- Create: `src/study-scheduler.mjs`
- Create: `test/study-scheduler.test.mjs`
- Modify: `src/study.mjs`
- Modify: `test/study.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `filterLessonsByQuery(lessons, queries): Lesson[]` moved from `study.mjs` without behavior changes.
- Produces: `selectEligibleLessons({ catalogLessons, memoLessons, queries, activeIds, attemptedIds, phase, dryRun, limit }): Lesson[]`.
- Produces: `runDynamicWorkerPool({ concurrency, loadCandidates, runItem, keyOf, onSettled }): Promise<SettledResult[]>`.
- Keeps: `study.mjs` re-exports `filterLessonsByQuery` and keeps `pickNextLesson` as a one-item wrapper for compatibility.

- [ ] **Step 1: Write eligibility tests**

Create `test/study-scheduler.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  runDynamicWorkerPool,
  selectEligibleLessons,
} from "../src/study-scheduler.mjs";

function catalog(id, { locked = false, completed = false } = {}) {
  return {
    knowledgeId: id,
    section: id,
    title: `${id} 标题`,
    completed,
    progressText: locked ? "需完成之前闯关任务点，该章节才能解锁" : "1个待完成任务点",
  };
}

function memo(id, { video = "pending", homework = "pending" } = {}) {
  return {
    knowledgeId: id,
    section: id,
    video: { status: video },
    homework: { status: homework },
  };
}

test("selectEligibleLessons excludes locked, active, attempted, and completed lessons", () => {
  const selected = selectEligibleLessons({
    catalogLessons: [catalog("1.1"), catalog("1.2", { locked: true }), catalog("1.3"), catalog("1.4")],
    memoLessons: [memo("1.1"), memo("1.2"), memo("1.3"), memo("1.4", { video: "done", homework: "submitted" })],
    queries: ["1"],
    activeIds: new Set(["1.1"]),
    attemptedIds: new Set(["1.3"]),
    phase: null,
    dryRun: false,
    limit: 3,
  });
  assert.deepEqual(selected, []);
});
```

- [ ] **Step 2: Write dynamic pool tests**

Append:

```js
test("runDynamicWorkerPool never exceeds concurrency and refills released slots", async () => {
  const items = ["a", "b", "c", "d"];
  let running = 0;
  let peak = 0;
  const completed = [];

  await runDynamicWorkerPool({
    concurrency: 3,
    keyOf: (item) => item,
    loadCandidates: ({ activeIds, attemptedIds }) =>
      items.filter((item) => !activeIds.has(item) && !attemptedIds.has(item)),
    runItem: async (item, slot) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, item === "a" ? 20 : 5));
      running -= 1;
      return { item, slot };
    },
    onSettled: ({ item }) => completed.push(item),
  });

  assert.equal(peak, 3);
  assert.deepEqual(new Set(completed), new Set(items));
});

test("runDynamicWorkerPool discovers an item unlocked by a completed predecessor", async () => {
  let unlocked = false;
  const started = [];
  await runDynamicWorkerPool({
    concurrency: 3,
    keyOf: (item) => item,
    loadCandidates: ({ activeIds, attemptedIds }) =>
      ["first", ...(unlocked ? ["second"] : [])]
        .filter((item) => !activeIds.has(item) && !attemptedIds.has(item)),
    runItem: async (item) => {
      started.push(item);
      if (item === "first") unlocked = true;
    },
  });
  assert.deepEqual(started, ["first", "second"]);
});

test("runDynamicWorkerPool isolates item failures and continues remaining work", async () => {
  const settled = [];
  await runDynamicWorkerPool({
    concurrency: 2,
    keyOf: (item) => item,
    loadCandidates: ({ activeIds, attemptedIds }) =>
      ["bad", "good"].filter((item) => !activeIds.has(item) && !attemptedIds.has(item)),
    runItem: async (item) => {
      if (item === "bad") throw new Error("lesson failed");
      return "done";
    },
    onSettled: (result) => settled.push(result),
  });
  assert.equal(settled.length, 2);
  assert.equal(settled.find((entry) => entry.item === "bad").status, "rejected");
  assert.equal(settled.find((entry) => entry.item === "good").status, "fulfilled");
});
```

- [ ] **Step 3: Run the scheduler tests and verify failure**

Run:

```bash
node --test test/study-scheduler.test.mjs
```

Expected: FAIL because `src/study-scheduler.mjs` does not exist.

- [ ] **Step 4: Move lesson query parsing and implement eligibility**

Move `parseSectionNumber`, `lessonSectionKey`, `lessonIdentity`, and `filterLessonsByQuery` from `study.mjs` into `study-scheduler.mjs`. Import `lessonNeedsWork` and `isLockedLesson`, then implement:

```js
export function selectEligibleLessons({
  catalogLessons,
  memoLessons,
  queries = null,
  activeIds = new Set(),
  attemptedIds = new Set(),
  phase = null,
  dryRun = false,
  limit = 1,
}) {
  return filterLessonsByQuery(catalogLessons, queries)
    .filter((lesson) => {
      const id = String(lesson.knowledgeId ?? "");
      if (!id || activeIds.has(id) || attemptedIds.has(id)) return false;
      if (lesson.completed || isLockedLesson(lesson)) return false;
      const memoLesson = memoLessons.find((candidate) => String(candidate.knowledgeId) === id);
      return Boolean(memoLesson && lessonNeedsWork(memoLesson, {
        phase,
        submitDryRun: !dryRun,
      }).any);
    })
    .slice(0, limit);
}
```

- [ ] **Step 5: Implement the dynamic worker pool**

Use numbered slots `1..concurrency`, an `active` map keyed by slot, and an `attemptedIds` set. `loadCandidates` receives copies of both identity sets. Fill all idle slots, then await `Promise.race` over active operations. Convert each operation into `{ status, item, slot, value? , reason? }`, remove it from `active`, add its key to `attemptedIds`, call `onSettled`, and refill. If `loadCandidates` returns no item while work remains, wait for active work; if no work remains, return all settled results.

If `loadCandidates` throws while workers are active, stop refilling, await all active operations through the same settlement path, then rethrow the catalog error. This preserves active lesson results instead of abandoning them.

- [ ] **Step 6: Re-export existing study helpers and update tests**

In `src/study.mjs` import the new helpers and export:

```js
export { filterLessonsByQuery } from "./study-scheduler.mjs";

export function pickNextLesson(catalogLessons, memoLessons, attempted, phase, dryRun = false) {
  return selectEligibleLessons({
    catalogLessons,
    memoLessons,
    activeIds: new Set(),
    attemptedIds: attempted,
    phase,
    dryRun,
    limit: 1,
  })[0] ?? null;
}
```

Keep existing `test/study.test.mjs` assertions unchanged so this move proves backward compatibility.

- [ ] **Step 7: Add scheduler syntax checking and run tests**

Add `node --check src/study-scheduler.mjs` to `package.json`, then run:

```bash
node --test test/study-scheduler.test.mjs test/study.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/study-scheduler.mjs test/study-scheduler.test.mjs src/study.mjs test/study.test.mjs package.json
git commit -m "feat: add lock-aware lesson worker scheduler"
```

---

### Task 5: Feed video, popup-quiz, homework, and failure events into progress slots

**Files:**
- Modify: `src/video-runner.mjs`
- Modify: `src/study.mjs`
- Modify: `test/study-progress.test.mjs`

**Interfaces:**
- Changes: `playManifestVideo({ frame, config, onProgress, onPopupQuiz })`; `onPopupQuiz` receives `{ status: "handling" }` before work and the existing result afterward.
- Changes: `processLesson`, `playVideoTask`, and `handleHomeworkTask` receive `{ progress, slot }`.
- Consumes: `StudyProgress.stage(slot, patch)` and `StudyProgress.video(slot, sample)` from Task 2.

- [ ] **Step 1: Add a failing event-to-display test**

Append to `test/study-progress.test.mjs`:

```js
test("StudyProgress shows popup quiz and homework retry stages for a page", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "课程", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "1.1 标题" });
  progress.stage(1, { name: "video-quiz", detail: "正在处理视频弹题" });
  progress.stage(1, { name: "homework", detail: "正在生成答案" });
  progress.stage(1, { name: "homework-retry", detail: "第 2/3 次尝试" });
  progress.finish(1, { status: "failed", detail: "作业失败" });
  progress.stop();

  assert.match(stream.output(), /正在处理视频弹题/);
  assert.match(stream.output(), /正在生成答案/);
  assert.match(stream.output(), /第 2\/3 次尝试/);
  assert.match(stream.output(), /作业失败/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --test test/study-progress.test.mjs
```

Expected: FAIL until `stage` and `finish` preserve and render every transition in the test stream.

- [ ] **Step 3: Emit popup quiz lifecycle events**

In `src/video-runner.mjs`, immediately before `handleVideoQuizWork`, call:

```js
await onPopupQuiz({ status: "handling", detail: "正在处理视频弹题" });
```

Retain the existing call with the final `quizResult` after handling. Do not change retry limits or answer behavior.

- [ ] **Step 4: Wire media samples and stages in study processing**

Extend `playVideoTask` to receive `progress` and `slot`. Before opening a task call:

```js
progress.stage(slot, { name: "video", taskTitle: task.title, detail: "正在打开视频" });
```

Call `playManifestVideo` with:

```js
onProgress: async (state, { targetSeconds }) => {
  progress.video(slot, {
    currentTime: state.currentTime,
    duration: state.duration,
    targetSeconds,
    speed: config.videoSpeed,
  });
},
onPopupQuiz: async (result) => {
  progress.stage(slot, {
    name: "video-quiz",
    taskTitle: task.title,
    detail: result.detail ?? (result.status === "handling" ? "正在处理视频弹题" : "视频弹题已处理"),
  });
},
```

Before homework surface detection use `name: "homework", detail: "正在读取作业"`; before `handleQuizWork` use `detail: "正在生成并填写答案"`; pass its existing `beforeSubmit` option to set `detail: "正在提交作业"`; and before each reanswer iteration set `name: "homework-retry", detail: `第 ${attempts + 2}/${HOMEWORK_MAX_ATTEMPTS} 次尝试``.

Route `surfaceFailure` through `progress.log` instead of direct `console.log`. Make `processLesson` accumulate each video/homework task's boolean result and return `{ status: "done" }` only when all attempted tasks succeed; return `{ status: "failed", detail }` after the first failed task. This return value is required by the worker settlement display in Task 6.

- [ ] **Step 5: Run progress and regression tests**

Run:

```bash
node --test test/study-progress.test.mjs test/task-point.test.mjs test/quiz.test.mjs test/study.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/video-runner.mjs src/study.mjs test/study-progress.test.mjs
git commit -m "feat: report lesson lifecycle and playback progress"
```

---

### Task 6: Replace serial course processing with the concurrent page pool

**Files:**
- Modify: `src/study.mjs`
- Modify: `src/study-cli.mjs`
- Modify: `test/study-scheduler.test.mjs`
- Modify: `test/study-cli.test.mjs`
- Modify: `test/study.test.mjs`

**Interfaces:**
- Changes: `runStudy({ dryRun, phase, config, coursesQuery, lessonsQuery, concurrency = config.studyConcurrency })`.
- Changes: `processCourse({ context, coordinatorPage, course, store, config, dryRun, phase, now, lessonsQuery, concurrency, progress })`.
- Produces: `markPendingLessonWorkFailed(memo, course, lesson, { phase, detail, now })` for deterministic failure-state updates.
- Consumes: `runDynamicWorkerPool`, `selectEligibleLessons`, and `StudyProgress`.

- [ ] **Step 1: Add a failing slot-reuse assertion to the pool test**

Extend the first `runDynamicWorkerPool` test to collect `{ item, slot }` from `onSettled` and assert:

```js
assert.ok(settled.every(({ slot }) => slot >= 1 && slot <= 3));
assert.equal(new Set(settled.map(({ item }) => item)).size, 4);
```

Add a test proving candidate loading receives the currently active IDs:

```js
test("runDynamicWorkerPool exposes active IDs while another page is running", async () => {
  const snapshots = [];
  await runDynamicWorkerPool({
    concurrency: 2,
    keyOf: (item) => item,
    loadCandidates: ({ activeIds, attemptedIds }) => {
      snapshots.push([...activeIds].sort());
      return ["a", "b"].filter((item) => !activeIds.has(item) && !attemptedIds.has(item));
    },
    runItem: async () => new Promise((resolve) => setTimeout(resolve, 5)),
  });
  assert.ok(snapshots.some((ids) => ids.length > 0));
});
```

Also add to `test/study.test.mjs`, importing `createStudyMemo`, `refreshCatalog`, and `setLessonVideo` from `study-memo.mjs` plus `markPendingLessonWorkFailed` from `study.mjs`:

```js
test("markPendingLessonWorkFailed preserves completed work and fails pending work", () => {
  const course = { courseId: "1", clazzId: "2", name: "课程" };
  const state = createStudyMemo({ courses: [course] });
  refreshCatalog(state, course, [{
    knowledgeId: "1.1",
    title: "1.1 标题",
    ordinal: 1,
    locked: false,
    catalogCompleted: false,
    pendingTaskCount: 2,
  }]);
  setLessonVideo(state, course, { knowledgeId: "1.1" }, { status: "done" });

  markPendingLessonWorkFailed(
    state,
    course,
    { knowledgeId: "1.1" },
    { phase: null, detail: "页面已关闭", now: () => new Date(0) },
  );

  const lesson = state.courses[0].lessons[0];
  assert.equal(lesson.video.status, "done");
  assert.equal(lesson.homework.status, "failed");
  assert.equal(lesson.homework.lastError, "页面已关闭");
});
```

- [ ] **Step 2: Run scheduler and study tests and verify the new assertions fail**

Run:

```bash
node --test test/study-scheduler.test.mjs test/study.test.mjs
```

Expected: FAIL if the Task 4 settlement object omits `slot`/active identity snapshots or because `markPendingLessonWorkFailed` is not defined.

- [ ] **Step 3: Refactor one-lesson execution into a worker function**

In `src/study.mjs`, create private `processAssignedLesson({ page, course, assignedLesson, store, config, dryRun, phase, now, progress, slot })`:

1. `progress.assign(slot, { lessonTitle: assignedLesson.label ?? assignedLesson.title })`.
2. Open a fresh course catalog in the worker page.
3. Find the current lesson by `knowledgeId`; if absent or now locked, return `{ status: "locked" }` without clicking it.
4. Refresh catalog through `store.mutate` and obtain the current memo lesson.
5. Open the lesson and call `processLesson` with `progress` and `slot`.
6. Return the exact `{ status: "done" | "failed", detail? }` from `processLesson`; for a missing content frame, persist the current failed states and return `{ status: "failed", detail: "课节打开后未找到内容帧" }`.

The worker must not call `progress.release`; slot release belongs to the coordinator settlement handler.

- [ ] **Step 4: Implement lock-aware concurrent course orchestration**

Replace the current serial `processCourse` loop with `runDynamicWorkerPool`:

```js
await runDynamicWorkerPool({
  concurrency,
  keyOf: (lesson) => String(lesson.knowledgeId),
  loadCandidates: async ({ activeIds, attemptedIds }) => {
    const { lessons: catalogLessons } = await openCourseCatalog(
      coordinatorPage,
      course,
      config.timeoutMs,
    );
    const courseRecord = await store.mutate((state) =>
      refreshCatalog(state, course, catalogLessons.map(toMemoLesson), now),
    );
    if (!courseStarted) {
      progress.startCourse({
        name: course.name,
        total: filterLessonsByQuery(catalogLessons, lessonsQuery).length,
        concurrency,
      });
      courseStarted = true;
    }
    return selectEligibleLessons({
      catalogLessons,
      memoLessons: courseRecord.lessons,
      queries: lessonsQuery,
      activeIds,
      attemptedIds,
      phase,
      dryRun,
      limit: concurrency - activeIds.size,
    });
  },
  runItem: async (lesson, slot) => {
    const page = workerPages.get(slot) ?? await context.newPage();
    workerPages.set(slot, page);
    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.timeoutMs);
    return processAssignedLesson({
      page,
      course,
      assignedLesson: lesson,
      store,
      config,
      dryRun,
      phase,
      now,
      progress,
      slot,
    });
  },
  onSettled: async ({ item, slot, status, value, reason }) => {
    if (status === "rejected") {
      const detail = reason?.message ?? String(reason);
      await recordUnexpectedLessonFailure({ store, course, lesson: item, phase, detail, now });
      progress.finish(slot, { status: "failed", detail });
    } else {
      progress.finish(slot, {
        status: value.status,
        detail: value.detail ?? `${item.label ?? item.title} 已处理`,
      });
    }
    progress.release(slot);
  },
});
```

Declare `let courseStarted = false` and create `workerPages` before running the pool. Close every worker page with `Promise.allSettled` in `finally`. Keep the coordinator page separate so catalog refreshes never navigate an active lesson page. `processAssignedLesson` must return the `{ status, detail }` produced by `processLesson`; use `status: "locked"` only for a catalog entry that became locked between assignment and page opening.

Implement exported failure-state logic:

```js
export function markPendingLessonWorkFailed(
  memo,
  course,
  lesson,
  { phase = null, detail, now = Date.now } = {},
) {
  const courseRecord = memo.courses.find(
    (candidate) => makeCourseKey(candidate) === makeCourseKey(course),
  );
  const record = courseRecord?.lessons.find(
    (candidate) => String(candidate.knowledgeId) === String(lesson.knowledgeId),
  );
  if (!record) throw new Error(`备忘录中不存在课节 ${lesson.knowledgeId ?? lesson.title ?? ""}。`);
  if (phase !== "homework" && videoNeedsWork(record.video)) {
    setLessonVideo(memo, course, lesson, { status: "failed", lastError: detail }, now);
  }
  if (phase !== "video" && homeworkNeedsWork(record.homework, { submitDryRun: true })) {
    setLessonHomework(memo, course, lesson, { status: "failed", lastError: detail }, now);
  }
  return record;
}

async function recordUnexpectedLessonFailure({ store, course, lesson, phase, detail, now }) {
  return store.mutate((memo) =>
    markPendingLessonWorkFailed(memo, course, lesson, { phase, detail, now }),
  );
}
```

This records a closed/crashed worker page without overwriting a video or homework result that was already persisted successfully.

- [ ] **Step 5: Initialize and stop progress at the run boundary**

In `runStudy`, accept `concurrency`, create `const progress = new StudyProgress()`, pass `browserContext` and the existing page as `context` and `coordinatorPage`, and replace direct course-start logs with `progress.log` or course state. Call `progress.stop()` in `finally` before closing the browser.

In `study-cli.mjs`, pass the Task 1 concurrency value. Do not change report path suffixes or report schema.

- [ ] **Step 6: Handle process interruption without leaving the cursor hidden**

Make `StudyProgress` register one-shot `SIGINT` and `SIGTERM` handlers in its constructor and remove both handlers in `stop()`. Use this exact handler factory so the second signal delivery uses Node's default termination behavior after cursor restoration:

```js
this.signalHandlers = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    this.stop();
    process.kill(process.pid, signal);
  }]),
);
for (const [signal, handler] of this.signalHandlers) process.once(signal, handler);
```

In `stop()`, call `process.removeListener(signal, handler)` before clearing the map. Test idempotence by asserting that two `stop()` calls produce one show-cursor sequence.

Add to `test/study-progress.test.mjs`:

```js
test("StudyProgress stop is idempotent and restores the cursor once", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "课程", total: 1, concurrency: 1 });
  progress.stop();
  progress.stop();
  assert.equal((stream.output().match(/\u001b\[\?25h/g) ?? []).length, 1);
});
```

- [ ] **Step 7: Run focused and full verification**

Run:

```bash
node --test test/study-scheduler.test.mjs test/study-progress.test.mjs test/study-cli.test.mjs test/study.test.mjs
npm test
npm run check
```

Expected: PASS, with no unhandled rejections or hanging signal listeners.

- [ ] **Step 8: Commit**

```bash
git add src/study.mjs src/study-cli.mjs src/study-progress.mjs test/study-scheduler.test.mjs test/study-progress.test.mjs test/study-cli.test.mjs test/study.test.mjs
git commit -m "feat: run unlocked lessons in concurrent pages"
```

---

### Task 7: Document usage and perform delivery verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Documents: `--concurrency 1..3` and `CHAOXING_STUDY_CONCURRENCY=1`.
- Documents: comma-list command syntax and automatic reduction for locked courses.

- [ ] **Step 1: Update environment example**

Add near the other study/video controls in `.env.example`:

```dotenv
# CHAOXING_STUDY_CONCURRENCY=1
```

- [ ] **Step 2: Update README command examples and behavior**

In the automatic-study section add:

```powershell
npm run study -- --course 科研诚信 --lesson "1.1,1.2,1.3" --concurrency 3
```

State explicitly:

- Default concurrency is 1 and maximum is 3.
- Each concurrent lesson uses a separate page and runs video plus homework.
- The terminal shows one progress bar per active page.
- Only unlocked lessons run; a gated course such as “创新创业基础” automatically runs effectively one at a time until later lessons unlock.
- Multiple selected courses remain sequential.

Add `CHAOXING_STUDY_CONCURRENCY=1` to the optional settings list.

- [ ] **Step 3: Run documentation and source consistency checks**

Run:

```bash
rg -n "STUDY_CONCURRENCY|--concurrency|进度条|锁定" README.md .env.example src test
npm test
npm run check
git diff --check
```

Expected: configuration names and limits are consistent; all tests and syntax checks pass; `git diff --check` prints nothing.

- [ ] **Step 4: Perform a safe CLI validation check**

Run:

```bash
node src/study-cli.mjs --concurrency 4
```

Expected: exits non-zero with `--concurrency 必须是 1 到 3 之间的整数。` before launching a browser.

- [ ] **Step 5: Perform manual platform verification when credentials are available**

Run the non-submitting video-only checks first:

```powershell
npm run study -- --phase video --course <允许并发的课程> --lesson "1.1,1.2,1.3" --concurrency 3
npm run study -- --phase video --course 创新创业 --lesson 1 --concurrency 3
```

Verify the first command displays three independently advancing bars and distinct browser pages. Verify the second never opens a locked lesson and runs at effective concurrency 1 until the catalog reports another lesson unlocked.

Then run one serial regression:

```powershell
npm run study -- --phase video --course <测试课程> --lesson 1.1 --concurrency 1
```

Verify it behaves like the prior serial workflow and writes the expected suffixed report files.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md .env.example
git commit -m "docs: explain concurrent lesson playback"
```

- [ ] **Step 7: Record final repository status**

Run:

```bash
git status --short
git log -8 --oneline
```

Expected: working tree is clean and the task commits appear in order.
