# Source Architecture 1: Baseline and Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish offline compatibility contracts and move all Chaoxing page adapters to `src/platform/` without changing runtime behavior.

**Architecture:** Existing top-level modules remain thin re-export shims; canonical platform modules own DOM selectors, navigation, discovery, task identity, and task-point status. Progress-table Markdown rendering moves to persistence so platform has no reverse dependency.

**Tech Stack:** Node.js >=20 ES modules, node:test, playwright-core (offline fakes only).

**Spec:** `docs/superpowers/specs/2026-09-26-source-architecture-maintainability-design.md`

## Global Constraints

- Pure refactor: no changes to CLI flags/text, selectors, retry or playback rules, concurrency, LLM endpoints/prompts, data formats, error semantics, privacy, or browser interactions.
- Keep all existing `src/*.mjs` paths and named exports; `login.mjs`, `progress-cli.mjs`, `study-cli.mjs` remain executable at current paths.
- No live login/study/submission/playback; offline tests only. Do not read `.env` or `.auth` content or run npm study/login commands.
- `npm test`, `npm run check`, `git diff --check` pass after each task. Small commits; no opportunistic fixes.
- This plan precedes `2026-09-26-source-architecture-2-assessment-video.md`, then `2026-09-26-source-architecture-3-learning-persistence.md`.

## File map

- Create `test/architecture-exports.test.mjs`: pin current non-entry module public export keys against a reviewed manifest.
- Create `src/platform/{selectors,courses,course-navigation,course-progress,task-manifest,task-point-status}.mjs`: canonical implementations moved without algorithm changes.
- Create `src/persistence/progress-format.mjs`: pure Markdown functions currently at end of `src/course-progress.mjs`.
- Modify root `src/{study-selectors,courses,course-navigation,course-progress,task-manifest,task-point-status}.mjs`: re-export the existing APIs.
- Modify `src/{login,progress-cli,study-memo}.mjs` and new platform imports: canonical imports; no backwards import into a shim.

### Task 1: Pin baseline public exports and serialized browser callback behavior

**Files:** Create `test/architecture-exports.test.mjs`; modify `test/quiz.test.mjs` only if a fixture is needed (do not change production).

**Interfaces:** Consumes current module exports, existing `collectQuestions(frame)` and selector constants. Produces a stable export-key manifest and offline execution check reused as regression guards in later plans.

- [ ] **Step 1: Record existing named exports before any moves.** Run `node --input-type=module -e "for (const n of ['config','courses','course-navigation','course-progress','study-selectors','task-manifest','task-point-status','quiz','answerer','video-preview','video-runner','task-point','study','study-memo','study-scheduler','study-progress']) console.log(n, Object.keys(await import('./src/'+n+'.mjs')).sort().join(','))"` and copy the exact printed keys into a literal `EXPECTED_EXPORTS` object in the new test. Do not import side-effectful `login.mjs` or `progress-cli.mjs` in this probe.
- [ ] **Step 2: Write a contract test, intentionally change one expected key to prove it fails, then restore that key.** Test body:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
const EXPECTED_EXPORTS = {
  config: ['parseBoolean','readConfig'],
  courses: ['filterIncompleteCourses','findCourseFrame','getIncompleteCourses'],
  'course-navigation': ['openTargetLesson','selectTargetCourse'],
  'course-progress': ['collectCourseProgress','collectProgressWithConcurrency','escapeMarkdownCell','listLessons','mapWithConcurrency','renderProgressMarkdown','summarizeLessons','waitForChapterFrame'],
  'study-selectors': ['STUDY_SELECTORS'],
  'task-manifest': ['classifyTaskKind','clickLessonInChapterFrame','clickTaskTab','discoverLessonTasks','extractCardId','findVisibleTaskSurface','isLockedLesson','makeTaskKey','openCourseCatalog','readTaskTabs','selectTaskTabIndex','waitForCardsFrame','waitForTaskSurface'],
  'task-point-status': ['parseTaskPointState','readTaskPointState'],
  quiz: ['classifyQuestionType','collectQuestions','detectQuizSubmissionState','fillAnswers','handleQuizWork','handleVideoQuizWork','isVideoQuizVisible','mapQType','normalizeOptionLabel','normalizeOptionText','normalizeQuestionStem','shouldSubmit'],
  answerer: ['answerQuestions','buildPrompt','callChatCompletions','normalizeAnswer','parseLlmJson','stripCodeFences'],
  'video-preview': ['readVideoState','startVideoPreview'],
  'video-runner': ['playManifestVideo'],
  'task-point': ['decideVideoEnded','hasReachedMediaTarget','mediaTargetSeconds','readMediaState','startMediaPlayback','waitForMediaEnd','waitForMediaReady','waitForMediaTarget','waitForMediaTaskCompletion'],
  study: ['buildStudyReport','filterCoursesByQuery','filterLessonsByQuery','lessonExecutionOrder','markPendingLessonWorkFailed','pickNextLesson','processLesson','runStudy'],
  'study-memo': ['HOMEWORK_STATUSES','STUDY_MEMO_SCHEMA_VERSION','StudyMemoStore','VIDEO_STATUSES','atomicWriteFile','createStudyMemo','homeworkNeedsWork','lessonNeedsHomework','lessonNeedsVideo','lessonNeedsWork','lessonStatusLabel','makeCourseKey','prepareMemoForSelection','readStudyMemo','refreshCatalog','renderStudyMemoMarkdown','setLessonHomework','setLessonVideo','validateStudyMemo','videoNeedsWork'],
  'study-scheduler': ['filterLessonsByQuery','runDynamicWorkerPool','selectEligibleLessons'],
  'study-progress': ['StudyProgress','formatMediaTime','formatProgressBar'],
};
test('old import paths retain named exports', async () => {
  for (const [name, expected] of Object.entries(EXPECTED_EXPORTS)) {
    assert.deepEqual(Object.keys(await import(`../src/${name}.mjs`)).sort(), expected, name);
  }
});
```

Expected red: `node --test test/architecture-exports.test.mjs` fails on the deliberately changed key. Restore, rerun green. Commit the baseline test by itself (`git add test/architecture-exports.test.mjs && git commit -m "test: pin source module compatibility exports"`).
- [ ] **Step 3: Confirm the existing browser-callback isolation fixture.** Run `node --test test/quiz.test.mjs`; its `collectQuestions runs its text normalization inside the page evaluation context` test must execute the callback from `callback.toString()` via `Function` without outer bindings. Keep this fixture in place throughout the refactor. Run full `npm test && npm run check && git diff --check`.

### Task 2: Move platform modules and split pure progress formatting

**Files:** Create `src/platform/{selectors,courses,course-navigation,course-progress,task-manifest,task-point-status}.mjs`, `src/persistence/progress-format.mjs`, `test/platform-imports.test.mjs`; modify existing six root shims plus `src/login.mjs`, `src/progress-cli.mjs`, `src/study-memo.mjs`.

**Interfaces:** Platform exports the same symbols as original root files (except progress Markdown formatting). `src/persistence/progress-format.mjs` exports `escapeMarkdownCell(value)` and `renderProgressMarkdown(report)`; root `course-progress.mjs` re-exports both alongside canonical platform exports. Subsequent plans import canonical platform modules.

- [ ] **Step 1: Write a failing canonical-import test.** Use `test/platform-imports.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
test('platform canonical modules and legacy paths share bindings', async () => {
  for (const [oldName, canonical, symbol] of [
    ['courses','platform/courses','getIncompleteCourses'],
    ['course-navigation','platform/course-navigation','openTargetLesson'],
    ['course-progress','platform/course-progress','listLessons'],
    ['task-manifest','platform/task-manifest','discoverLessonTasks'],
    ['task-point-status','platform/task-point-status','readTaskPointState'],
    ['study-selectors','platform/selectors','STUDY_SELECTORS'],
    ['course-progress','persistence/progress-format','renderProgressMarkdown'],
  ]) {
    const oldModule = await import(`../src/${oldName}.mjs`);
    const nextModule = await import(`../src/${canonical}.mjs`);
    assert.strictEqual(oldModule[symbol], nextModule[symbol], symbol);
  }
});
```

Run `node --test test/platform-imports.test.mjs`; expected red: `ERR_MODULE_NOT_FOUND` for `src/platform/courses.mjs`.
- [ ] **Step 2: Move implementation bodies without changing algorithms.** For each of `study-selectors`, `courses`, `course-navigation`, `task-manifest`, `task-point-status` use `git mv src/<name>.mjs src/platform/<canonical>.mjs`; rewrite relative imports within canonical files to `./...` for platform siblings. Recreate root `src/<name>.mjs` as `export * from './platform/<canonical>.mjs';`. In `platform/course-navigation.mjs`, import `findCourseFrame` from `./courses.mjs`; in `platform/task-manifest.mjs`, import `listLessons, waitForChapterFrame` from `./course-progress.mjs` and selectors from `./selectors.mjs`; in `platform/task-point-status.mjs`, import from `./selectors.mjs` and `./task-manifest.mjs`. Keep DOM callback bodies verbatim.
- [ ] **Step 3: Split `course-progress.mjs` at `export function escapeMarkdownCell`.** Put `waitForChapterFrame`, `summarizeLessons`, `mapWithConcurrency`, `listLessons`, `collectCourseProgress`, `collectProgressWithConcurrency` with unchanged implementations in `src/platform/course-progress.mjs`; put `escapeMarkdownCell` and `renderProgressMarkdown` with unchanged implementations in `src/persistence/progress-format.mjs`; root shim:

```js
export * from './platform/course-progress.mjs';
export { escapeMarkdownCell, renderProgressMarkdown } from './persistence/progress-format.mjs';
```

Point `src/progress-cli.mjs` at canonical platform progress for collection and persistence progress-format for Markdown; point `src/study-memo.mjs` at canonical progress-format for `escapeMarkdownCell`. In `src/login.mjs`, import course navigation and courses from `./platform/course-navigation.mjs` and `./platform/courses.mjs`. Fix canonical imports only, no selector/formatter changes.
- [ ] **Step 4: Verify and commit.** Run `node --test test/platform-imports.test.mjs test/architecture-exports.test.mjs test/task-manifest.test.mjs test/task-point-status.test.mjs test/course-progress.test.mjs && npm test && npm run check && git diff --check`; expected: all pass. Confirm no `src/platform/*` imports from root shims, assessment, learning, or persistence (`rg -n 'from ' src/platform`). Commit `git add src test && git commit -m "refactor: isolate platform page adapters"`. No live commands.
