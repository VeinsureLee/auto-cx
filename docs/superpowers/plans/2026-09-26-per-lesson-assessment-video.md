# Per-Lesson Assessment-First Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change normal study execution to process each lesson as assessment-first then ordered video playback, using task-point completion state instead of a fixed 95% target and handling every in-video quiz occurrence.

**Architecture:** Keep the existing lock-aware concurrent lesson pool and one-page-per-lesson model. Refactor the lesson worker into an assessment gate followed by sequential video tasks; give each video task a stable task-point state reader and a completion-aware media wait loop. Preserve explicit `--phase video`, `--phase homework`, and dry-run exceptions.

**Tech Stack:** Node.js 20+, ECMAScript modules, Playwright Core, existing `node:test` suite, atomic study memo persistence.

**Spec:** `docs/superpowers/specs/2026-09-26-per-lesson-assessment-video-design.md`

## Global Constraints

- Normal `study` and `study:dry` execute assessment → that lesson’s ordered videos.
- Formal mode requires assessment submission before video; final assessment failure skips that lesson’s videos.
- Dry-run assessment fill success permits video and remains visibly unsubmitted.
- `--phase video` remains video-only; `--phase homework` remains homework-only.
- Video defaults to natural 100% playback; a clearly completed task-point icon may end playback early.
- No identifiable task-point state means natural playback must reach 100%; unknown state is never treated as completed.
- A video that reaches the end while task-point state remains pending waits for platform synchronization and fails after a bounded timeout.
- Every newly appearing in-video popup quiz is handled; remove the per-video cumulative three-popup cap. Per-popup option attempts remain bounded.
- No seek, drag, fake focus, captcha bypass, or lesson-gate bypass.
- Concurrency remains 1–3, default 1; one lesson page may run assessment and videos concurrently with other lesson pages, but not internally.
- Node.js `>=20`, no runtime dependency additions, memo/report schema versions unchanged.

---

## File Structure

- Create `src/task-point-status.mjs`: parse task-point completion state and expose stable state-reading helpers.
- Modify `src/study-selectors.mjs`: add task-point icon/condition selectors and completion markers.
- Modify `src/task-manifest.mjs`: attach task-point identity/context to discovered video tasks.
- Modify `src/task-point.mjs`: default media target 100%, poll task-point state, support early completion and bounded post-end sync wait.
- Modify `src/video-runner.mjs`: consume task-point state reader, remove cumulative popup cap, retain per-popup handling.
- Modify `src/study.mjs`: reorder each lesson to assessment first, gate video on assessment result, preserve phase/dry-run behavior.
- Modify `src/study-progress.mjs`: render media percentage separately from task-point state and assessment dry-run labels.
- Modify tests: `test/task-point-status.test.mjs`, `test/task-point.test.mjs`, `test/video-runner.test.mjs`, `test/study.test.mjs`, `test/study-progress.test.mjs`, and `test/config.test.mjs` if the old 95% setting is removed or defaulted.
- Modify `README.md` and `.env.example`: document assessment-first ordering, task-point completion behavior, default 100%, and repeated popup handling.

---

### Task 1: Add task-point completion-state parsing

**Files:**
- Create: `src/task-point-status.mjs`
- Modify: `src/study-selectors.mjs`
- Create: `test/task-point-status.test.mjs`

**Interfaces:**
- Produces `parseTaskPointState({ ariaLabel, text, className, completed })`, returning exactly `"completed" | "pending" | "unavailable"`.
- Produces `readTaskPointState(page, task, selectors?)`, returning `{ state, conditionText, source }` without changing media time.
- Consumes stable task identity fields `cardId`, `tabId`, and `ordinal` from Task 2.

- [ ] **Step 1: Write failing parser tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskPointState } from "../src/task-point-status.mjs";

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
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run `node --test test/task-point-status.test.mjs`; expected failure: `ERR_MODULE_NOT_FOUND` for `src/task-point-status.mjs`.

- [ ] **Step 3: Implement conservative parsing**

Normalize whitespace and prioritize explicit negative words (`未完成`, `未达成`, `待完成`) as `pending`, then explicit positive words (`已完成`, `完成`, `已达成`) and completion classes (`done`, `complete`, `finished`, `clear`) as `completed`; return `unavailable` otherwise. Do not infer completion from a percentage condition string.

Add selectors under `STUDY_SELECTORS.taskPoint`, including the icon candidates, condition text, and completion class/attribute candidates. `readTaskPointState` must search only the current task tab or its associated task-point DOM, read attributes/text, and return `unavailable` when no stable element is found.

- [ ] **Step 4: Run focused tests and commit**

Run `node --test test/task-point-status.test.mjs test/task-manifest.test.mjs`; expected PASS. Commit:

```bash
git add src/task-point-status.mjs src/study-selectors.mjs test/task-point-status.test.mjs
git commit -m "feat: parse lesson task-point completion state"
```

---

### Task 2: Attach task identity and implement completion-aware media waiting

**Files:**
- Modify: `src/task-manifest.mjs`
- Modify: `src/task-point.mjs`
- Modify: `test/task-point.test.mjs`

**Interfaces:**
- `discoverLessonTasks` video tasks retain `cardId`, `tabId`, and `ordinal` for task-point lookup.
- Produces `waitForMediaTaskCompletion(frame, mediaType, metadataTimeoutMs, options)`, returning `{ status: "reached_target" | "task_completed" | "error" | "skipped", state, taskPointState }`.
- Existing `waitForMediaTarget` remains available for compatibility but defaults to target 100 when no target is passed.

- [ ] **Step 1: Write failing media tests**

Add tests using the existing fake media frame:

```js
test("media completion defaults to natural 100 percent", async () => {
  const fake = createMediaFrame([
    { currentTime: 95, duration: 100, ended: false, paused: false, readyState: 4 },
    { currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 },
  ]);
  const result = await waitForMediaTarget(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
  });
  assert.equal(result.status, "reached_target");
  assert.equal(result.targetSeconds, 100);
});

test("task-point completed can finish before natural end", async () => {
  const fake = createFakeTaskPointFrame({
    mediaStates: [{ currentTime: 50, duration: 100, ended: false, paused: false, readyState: 4 }],
    taskStates: ["completed"],
  });
  const result = await waitForMediaTaskCompletion(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    readTaskPoint: fake.readTaskPoint,
  });
  assert.equal(result.status, "task_completed");
});

test("pending task-point after end waits then fails", async () => {
  const fake = createFakeTaskPointFrame({
    mediaStates: [{ currentTime: 100, duration: 100, ended: true, paused: true, readyState: 4 }],
    taskStates: ["pending", "pending", "pending"],
  });
  const result = await waitForMediaTaskCompletion(fake.frame, "video", 30_000, {
    now: fake.now,
    pollIntervalMs: 1_000,
    completionSyncTimeoutMs: 2_000,
    readTaskPoint: fake.readTaskPoint,
  });
  assert.equal(result.status, "error");
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run `node --test test/task-point.test.mjs`; expected failure for the missing helper and the old 95%-specific target expectation.

- [ ] **Step 3: Implement default-100 and task completion loop**

Change `waitForMediaTarget` default `targetPercent` to `100`. Preserve explicit percentage support only for compatibility tests; `playManifestVideo` must not pass `config.videoTargetPercent`.

Implement `waitForMediaTaskCompletion` around the existing media polling logic:

```js
const taskState = await readTaskPoint();
if (taskState.state === "completed") return { status: "task_completed", state, taskPointState: taskState };
if (naturalEnd && taskState.state === "unavailable") return { status: "reached_target", state, taskPointState: taskState };
if (naturalEnd && now() - endedAt >= completionSyncTimeoutMs) return { status: "error", detail: "视频已播放结束但任务点仍未完成", state, taskPointState: taskState };
```

Use a bounded default `completionSyncTimeoutMs` of 15 seconds, reset ended-time only if media leaves the ended state or task state changes. Keep `onTick`, `onSample`, and playback-rate maintenance. Do not set `currentTime`.

- [ ] **Step 4: Add task identity to manifest tasks**

Ensure every video task already carries `cardId`, `tabId`, and `ordinal`; add a `taskPoint` object only if needed by the reader. Do not change task ordering.

- [ ] **Step 5: Run focused/full tests and commit**

Run:

```bash
node --test test/task-point.test.mjs test/task-point-status.test.mjs
npm test
npm run check
```

Commit:

```bash
git add src/task-manifest.mjs src/task-point.mjs test/task-point.test.mjs
git commit -m "feat: wait for task-point completion instead of fixed target"
```

---

### Task 3: Remove cumulative popup cap and preserve repeated quiz handling

**Files:**
- Modify: `src/video-runner.mjs`
- Modify: `src/quiz.mjs`
- Modify: `src/study-selectors.mjs`
- Modify: `test/video-runner.test.mjs`
- Modify: `test/quiz.test.mjs`

**Interfaces:**
- `playManifestVideo` accepts `readTaskPoint` and `completionSyncTimeoutMs` through options/dependencies.
- `onPopupQuiz` receives `{ status: "handling", sequence }` before every distinct popup occurrence and the final result afterward.
- `handleVideoQuizWork` continues bounded per-popup option attempts but no longer enforces an entire-video cumulative `maxAttempts`.

- [ ] **Step 1: Write failing repeated-popup test**

Extend the video-runner test seam so visibility returns `true, false, true, false`, media reaches completion only after those callbacks, and handler returns answered each time:

```js
test("playManifestVideo handles each distinct popup occurrence", async () => {
  const events = [];
  let visibleCalls = 0;
  await playManifestVideo({
    frame: {},
    config: { videoSpeed: 2, timeoutMs: 1_000 },
    onPopupQuiz: async (event) => events.push(event),
    deps: {
      startMediaPlayback: async () => {},
      isVideoQuizVisible: async () => ++visibleCalls % 2 === 1,
      handleVideoQuizWork: async () => ({ status: "answered", detail: "ok" }),
      waitForMediaTaskCompletion: async (_frame, _type, _timeout, options) => {
        await options.onTick();
        await options.onTick();
        return { status: "reached_target", state: { currentTime: 100, duration: 100 } };
      },
    },
  });
  assert.deepEqual(events.filter((event) => event.status === "handling").map((event) => event.sequence), [1, 2]);
});
```

- [ ] **Step 2: Run the focused test and observe the cumulative-cap failure**

Run `node --test test/video-runner.test.mjs`; expected failure until `playManifestVideo` uses the new task completion helper and removes the cumulative popup counter.

- [ ] **Step 3: Implement repeated popup handling**

Replace `popupAttempts` with a monotonic `popupSequence` used only for display. Each `onTick` transition from not-visible to visible increments sequence and handles the popup. Do not process the same visible popup repeatedly while it remains open; track `popupWasVisible` and reset after it closes. Remove the `STUDY_SELECTORS.videoQuiz.maxAttempts` check from the outer video loop. Leave option-level finite iteration in `handleVideoQuizWork` unchanged.

- [ ] **Step 4: Wire task completion helper**

Use `waitForMediaTaskCompletion` rather than `waitForMediaTarget`, pass `readTaskPoint` and `completionSyncTimeoutMs`, and forward `onSample`/`onTick`. A `task_completed` or natural `reached_target` result succeeds; error/skipped throws the existing `VideoPlaybackError` with `blocked` semantics.

- [ ] **Step 5: Run tests and commit**

Run `node --test test/video-runner.test.mjs test/quiz.test.mjs test/task-point.test.mjs && npm run check`; expected PASS. Commit:

```bash
git add src/video-runner.mjs src/quiz.mjs src/study-selectors.mjs test/video-runner.test.mjs test/quiz.test.mjs
git commit -m "feat: handle repeated in-video quizzes"
```

---

### Task 4: Reorder lesson execution to assessment-first

**Files:**
- Modify: `src/study.mjs`
- Modify: `test/study.test.mjs`
- Modify: `test/study-progress.test.mjs`

**Interfaces:**
- `processLesson` becomes assessment-first for normal/dry-run modes and returns `{ status: "done" | "failed", detail? }`.
- `playVideoTask` receives `{ taskPointReader, completionSyncTimeoutMs }` and reports task-point state separately from media percentage.
- Existing `handleHomeworkTask` return status remains the gate: formal `submitted`, dry-run `dry_run` are successful; all other terminal states fail the lesson gate.

- [ ] **Step 1: Add a unit-testable lesson-order helper**

Export a small pure helper from `study.mjs`:

```js
export function lessonExecutionOrder({ phase, homeworkResult, videoTaskCount }) {
  if (phase === "video") return ["video"];
  if (phase === "homework") return ["homework"];
  if (!homeworkResult.success) return ["homework", "blocked-video"];
  return ["homework", ...(videoTaskCount ? ["video"] : [])];
}
```

Add tests:

```js
test("normal lesson order gates video on successful homework", () => {
  assert.deepEqual(
    lessonExecutionOrder({ phase: null, homeworkResult: { success: true }, videoTaskCount: 2 }),
    ["homework", "video"],
  );
  assert.deepEqual(
    lessonExecutionOrder({ phase: null, homeworkResult: { success: false }, videoTaskCount: 2 }),
    ["homework", "blocked-video"],
  );
});

test("phase video bypasses homework only when explicitly requested", () => {
  assert.deepEqual(lessonExecutionOrder({ phase: "video", homeworkResult: { success: false }, videoTaskCount: 1 }), ["video"]);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run `node --test test/study.test.mjs`; expected missing-export failure.

- [ ] **Step 3: Reorder `processLesson`**

For `phase !== "video"`, process all assessment tasks first. If no assessment task exists, mark homework `none` and treat the homework gate as successful. If a task exists, call `handleHomeworkTask`; any false result returns `{ status: "failed", detail }` immediately and must not call `playVideoTask`.

For `phase === "video"`, skip assessment entirely. For successful normal/dry-run assessment gate, process video tasks in returned order, one at a time; stop at the first false result. Keep existing `phase === "homework"` behavior and never call video.

Ensure a task-less lesson is not reported done when `surfaceFailure` indicates an expected video/assessment surface failure; persist failure rather than falsely setting both tasks to `none`.

- [ ] **Step 4: Wire task-point state and progress**

For each video task, create a reader closure that calls `readTaskPointState(page, task)`. Pass it to `playManifestVideo`; update progress with both `mediaPercent` and `taskPointState`. Render `completed`, `pending`, and `unavailable` distinctly. Do not make a `pending` icon look complete merely because media reached 100%.

- [ ] **Step 5: Test dry-run and exact order**

Add tests that inject fake homework/video handlers or test the pure helper and assert:

- normal success order is homework before video;
- homework failure yields no video call;
- dry-run homework success permits video;
- `phase: "video"` permits video without homework;
- `phase: "homework"` never invokes video;
- two video tasks are called in manifest order.

Run `node --test test/study.test.mjs test/study-progress.test.mjs test/video-runner.test.mjs`; expected PASS.

- [ ] **Step 6: Commit**

```bash
git add src/study.mjs test/study.test.mjs test/study-progress.test.mjs
 git commit -m "feat: require lesson homework before video"
```

---

### Task 5: Remove fixed 95% configuration and update progress/docs

**Files:**
- Modify: `src/config.mjs`
- Modify: `test/config.test.mjs`
- Modify: `src/study-progress.mjs`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- `config.videoTargetPercent` is no longer used by normal video playback; retain it only if compatibility requires parsing old environment files, but do not advertise it as a completion control.
- Progress API accepts `taskPointState` and displays it separately from media time percent.

- [ ] **Step 1: Add failing configuration/progress documentation tests**

Update config tests to assert the new default playback behavior is 100 or that `videoTargetPercent` is absent, matching the implementation choice from Task 2. Add progress assertions:

```js
test("progress display distinguishes media completion from task-point state", () => {
  const stream = memoryStream(true);
  const progress = new StudyProgress({ stream, errorStream: stream, redrawIntervalMs: 0 });
  progress.startCourse({ name: "课程", total: 1, concurrency: 1 });
  progress.assign(1, { lessonTitle: "1.1" });
  progress.stage(1, { name: "video", taskPointState: "pending" });
  progress.video(1, { currentTime: 100, duration: 100, targetSeconds: 100, speed: 2, taskPointState: "pending" });
  progress.stop();
  assert.match(stream.output(), /任务点未完成/);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run `node --test test/config.test.mjs test/study-progress.test.mjs`; expected failure for new task-point display/default assertions.

- [ ] **Step 3: Implement progress and config cleanup**

Keep media progress as `currentTime / duration` for display, add task-point state text, and show `任务点已完成`, `任务点未完成`, or `任务点状态未知`. Do not convert pending to complete at 100%.

Remove fixed 95% from README and `.env.example`. If `CHAOXING_VIDEO_TARGET_PERCENT` remains parsed for backward compatibility, document that it no longer controls task completion and that playback completion is 100%/task-point state; otherwise remove it and update tests consistently.

- [ ] **Step 4: Update README behavior examples**

Document:

- normal per-lesson order is assessment then ordered videos;
- formal assessment failure skips that lesson’s videos and retries assessment;
- dry-run fill success permits video without submission;
- `--phase video` bypasses assessment explicitly;
- task-point icon governs early completion, unknown icon uses 100%, pending after end waits and fails;
- repeated in-video quizzes are processed individually;
- concurrency applies to lessons, not to tasks inside one lesson.

- [ ] **Step 5: Run tests/check and commit**

Run `npm test`, `npm run check`, and `git diff --check`; expected all pass. Commit:

```bash
git add src/config.mjs test/config.test.mjs src/study-progress.mjs .env.example README.md
git commit -m "docs: explain assessment-first task-point playback"
```

---

### Task 6: Integration verification and safe delivery checks

**Files:**
- Modify: `package.json` only if new syntax-check files need listing.
- Modify: relevant tests only if integration gaps are discovered.

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
npm test
npm run check
git diff --check
```

Expected: all tests pass, syntax checks exit 0, no diff-check output.

- [ ] **Step 2: Validate CLI behavior without launching a browser**

Run `node src/study-cli.mjs --concurrency 4`; expected nonzero validation error before browser launch. Verify `--phase video` and `--phase homework` parse unchanged.

- [ ] **Step 3: Inspect final behavior contracts**

Use `rg` to confirm no normal playback path passes `videoTargetPercent` into `playManifestVideo`, no outer cumulative `maxAttempts` check remains, and `processLesson` invokes assessment before video except for explicit `phase === "video"`.

- [ ] **Step 4: Manual verification only with explicit permission**

Do not run live course commands automatically. When approved, start with a small `--phase video` task to verify task-point selectors and repeated popups, then a small dry-run lesson to verify assessment-first gating. Avoid formal submissions until the user explicitly requests them.

- [ ] **Step 5: Record delivery status**

Report automated results and clearly state whether live-platform verification was performed; do not claim live behavior without a real-platform run.
