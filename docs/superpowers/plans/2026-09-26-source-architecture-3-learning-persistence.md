# Source Architecture 3: Learning, Persistence, and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish organizing source into persistent state/report modules and focused lesson, worker, scheduler, progress, and run modules; maintain old paths and command behavior.

**Architecture:** Persistence owns memo/report serialization; learning coordinates it and platform/assessment/video adapters. Root paths re-export canonical symbols. A recursive syntax-check script covers the newly nested source tree.

**Tech Stack:** Node.js >=20 ES modules, node:test, playwright-core; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-26-source-architecture-maintainability-design.md`

## Global Constraints

- Complete both platform and assessment/video plans before starting. Preserve all legacy named exports and npm script entrypoints.
- Pure refactor: no change to behavior, data format, errors, CLI output, selectors, task order, retry/timing, API calls, privacy, defaults, or site actions.
- Do not run real-platform login, study, submission or playback. Use offline fixture tests only. Check `npm test && npm run check && git diff --check` at each review boundary.
- Keep canonical source independent of top-level compatibility modules; no import cycles. Do not alter browser cleanup, signal handling or memo mutation ordering.

## File map

- Create `src/persistence/memo.mjs` from root `study-memo.mjs`; `src/persistence/report-builder.mjs` from `buildStudyReport` and `lessonDetail` in `study.mjs`; `src/persistence/study-report.mjs` from report rendering/writing in `study-cli.mjs`. Create `src/shared/lesson-filter.mjs` for the pure existing `filterLessonsByQuery` used by both scheduler and report builder.
- Create `src/learning/{scheduler,progress,selection,lesson,course-worker,run-study}.mjs` from root study, study-scheduler and study-progress logic.
- Modify root `src/{study-memo,study-scheduler,study-progress,study}.mjs` to re-export canonical symbols; keep `src/study-cli.mjs` executable and re-export its old report helpers.
- Add `scripts/check-syntax.mjs`, change `package.json` check script, and add a short dependency map to README. Add `test/persistence-imports.test.mjs`, `test/learning-imports.test.mjs`, `test/architecture-boundaries.test.mjs`.

### Task 1: Isolate memo and report persistence

**Files:** Create `src/persistence/{memo,report-builder,study-report}.mjs`, `test/persistence-imports.test.mjs`; modify `src/{study-memo,study-cli,study}.mjs` minimally.

**Interfaces:** `persistence/memo.mjs` exports every current `study-memo.mjs` symbol. `persistence/report-builder.mjs` exports `buildStudyReport({memo, courseIds, dryRun, requestedPhase, fatalError, lessonsQuery, generatedAt})`; `persistence/study-report.mjs` exports `renderStudyReportMarkdown(report)` and `writeStudyReport(report, config)`; old `study.mjs` and `study-cli.mjs` re-export their existing public functions.

- [ ] **Step 1: Write failing canonical-import and report-contract tests.** In `test/persistence-imports.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
test('persistent modules keep old APIs', async () => {
  const memo = await import('../src/study-memo.mjs');
  const canonical = await import('../src/persistence/memo.mjs');
  const study = await import('../src/study.mjs');
  const builder = await import('../src/persistence/report-builder.mjs');
  const cli = await import('../src/study-cli.mjs');
  const report = await import('../src/persistence/study-report.mjs');
  assert.strictEqual(memo.StudyMemoStore, canonical.StudyMemoStore);
  assert.strictEqual(study.buildStudyReport, builder.buildStudyReport);
  assert.strictEqual(cli.renderStudyReportMarkdown, report.renderStudyReportMarkdown);
  assert.strictEqual(cli.writeStudyReport, report.writeStudyReport);
});
```

Run `node --test test/persistence-imports.test.mjs`; expected `ERR_MODULE_NOT_FOUND`. Also pin JSON structure using in-memory fixture code in the same test file:

```js
const { createStudyMemo, refreshCatalog } = await import('../src/study-memo.mjs');
const { buildStudyReport } = await import('../src/study.mjs');
const course = { courseId:'c', clazzId:'k', name:'Course' };
const now = () => new Date('2026-09-26T00:00:00.000Z');
const memo = createStudyMemo({ courses:[course], now });
refreshCatalog(memo, course, [{ knowledgeId:'L', title:'Lesson', ordinal:1, completed:false }], now);
const report = buildStudyReport({memo,courseIds:['c:k'],dryRun:false,generatedAt:now().toISOString()});
assert.deepEqual(Object.keys(report), ['schemaVersion','generatedAt','dryRun','requestedPhase','fatalError','courses']);
assert.deepEqual(Object.keys(report.courses[0].lessons[0]), ['title','knowledgeId','ordinal','status','detail','video','homework']);
assert.equal(report.courses[0].lessons[0].video.status, 'pending');
assert.equal(report.courses[0].lessons[0].homework.status, 'pending');
```

Keep this passing baseline during the move. Use a temp directory for any write-test files, not `artifacts/`.
- [ ] **Step 2: Move memo unchanged and update canonical consumers.** `git mv src/study-memo.mjs src/persistence/memo.mjs`; root `src/study-memo.mjs`:

```js
export * from './persistence/memo.mjs';
```

Update imports from root memo to `./persistence/memo.mjs` in root `study.mjs` and `study-scheduler.mjs` until learning moves in Task 2; `src/persistence/memo.mjs` imports `escapeMarkdownCell` from `./progress-format.mjs`.
- [ ] **Step 3: Extract pure filter and report helpers without changing any string or field.** Transfer `parseSectionNumber`, `lessonSectionKey`, `lessonIdentity`, and the original `filterLessonsByQuery` function bodies together from `study-scheduler.mjs` to `src/shared/lesson-filter.mjs`; canonical `study-scheduler.mjs` imports it from `./shared/lesson-filter.mjs` for internal use and re-exports it using `export { filterLessonsByQuery } from './shared/lesson-filter.mjs';` so the old binding remains accessible. Transfer original `lessonDetail`, `buildStudyReport` from `study.mjs` to `src/persistence/report-builder.mjs`, importing `makeCourseKey,lessonStatusLabel` from `./memo.mjs` and `filterLessonsByQuery` from `../shared/lesson-filter.mjs`. In `study.mjs` import the canonical builder for internal calls and `export { buildStudyReport } from './persistence/report-builder.mjs';`. Transfer the original `renderStudyReportMarkdown` and `writeStudyReport` from `study-cli.mjs` into `src/persistence/study-report.mjs`, importing `escapeMarkdownCell` from `./progress-format.mjs`; `study-cli.mjs` imports the canonical writer and re-exports both functions:

```js
import { writeStudyReport } from './persistence/study-report.mjs';
export { renderStudyReportMarkdown, writeStudyReport } from './persistence/study-report.mjs';
```

Keep CLI `IS_MAIN`, messages, file names, and catch behavior unchanged. Avoid importing a shim back from canonical code after Task 2.
- [ ] **Step 4: Verify and commit.** Run `node --test test/persistence-imports.test.mjs test/study-memo.test.mjs test/study-cli.test.mjs test/architecture-exports.test.mjs && npm test && npm run check && git diff --check`; expected all pass. Commit `git add src test && git commit -m "refactor: isolate memo and report persistence"`.

### Task 2: Split learning scheduler, lesson workflow and browser ownership

**Files:** Create `src/learning/{scheduler,progress,selection,lesson,course-worker,run-study}.mjs`, `test/learning-imports.test.mjs`; modify root `src/{study-scheduler,study-progress,study}.mjs` and canonical imports.

**Interfaces:** `learning/selection.mjs` exports `filterCoursesByQuery(courses,queries)`, `pickNextLesson(catalogLessons,memoLessons,attempted,phase,dryRun)`, and `loadSelectedCourses(config,coursesQuery)` (canonical-only helper, not exported by root study). `learning/lesson.mjs` exports `processLesson({...})`, `lessonExecutionOrder({...})`, `markPendingLessonWorkFailed(memo,course,lesson,{phase,detail,now})`. `learning/course-worker.mjs` exports `processCourse({...})`; `learning/run-study.mjs` exports `runStudy({...})`. Root `study.mjs` exports only the original named API, including `buildStudyReport` and `filterLessonsByQuery`.

- [ ] **Step 1: Write a failing import test.** In `test/learning-imports.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
test('learning canonical modules keep old bindings', async () => {
  const old = await import('../src/study.mjs');
  const lesson = await import('../src/learning/lesson.mjs');
  const run = await import('../src/learning/run-study.mjs');
  const scheduler = await import('../src/learning/scheduler.mjs');
  const oldScheduler = await import('../src/study-scheduler.mjs');
  assert.strictEqual(old.processLesson, lesson.processLesson);
  assert.strictEqual(old.runStudy, run.runStudy);
  assert.strictEqual(oldScheduler.selectEligibleLessons, scheduler.selectEligibleLessons);
});
```

Run `node --test test/learning-imports.test.mjs`; expected `ERR_MODULE_NOT_FOUND`. Existing `test/study.test.mjs` has offline phase, ordering, failure gate and per-task resume fixtures; preserve them.
- [ ] **Step 2: Move scheduler and progress.** `git mv src/study-scheduler.mjs src/learning/scheduler.mjs` and `git mv src/study-progress.mjs src/learning/progress.mjs`; root shims `export * from './learning/scheduler.mjs';` and `export * from './learning/progress.mjs';`. In canonical scheduler import `lessonNeedsWork` from `../persistence/memo.mjs`, `isLockedLesson` from `../platform/task-manifest.mjs`, and `filterLessonsByQuery` from `../shared/lesson-filter.mjs`; re-export the latter from the shared file for the legacy API. In canonical progress preserve signal handlers, rendering and timing verbatim.
- [ ] **Step 3: Extract the old `study.mjs` blocks into focused learning files without reordering statements.** Move original `filterCoursesByQuery`, `loadSelectedCourses`, and `pickNextLesson` to `selection.mjs` (export `loadSelectedCourses` only from this canonical file); import `readFile` there and `makeCourseKey` from `../persistence/memo.mjs`, `selectEligibleLessons` from `./scheduler.mjs`. Move `homeworkStatusFromResult`, `taskKeyOf`, `addCompletedTaskKeys`, `markPendingLessonWorkFailed`, `lessonExecutionOrder`, `playVideoTask`, `isDetachedError`, `HOMEWORK_MAX_ATTEMPTS`, `handleHomeworkTask`, `processLesson` to `lesson.mjs`; import original dependencies from `../platform/{task-manifest,task-point-status}.mjs`, `../assessment/chapter-quiz.mjs`, `../video/runner.mjs`, `../persistence/memo.mjs`. Move `toMemoLesson`, `recordUnexpectedLessonFailure`, `processAssignedLesson`, `processCourse` to `course-worker.mjs`, importing `processLesson,markPendingLessonWorkFailed` from `./lesson.mjs` and catalog/memo/scheduler/progress dependencies canonically. Move `withSuffix`, `lessonWorkerSuffix`, `runStudy` into `run-study.mjs`, importing `loadSelectedCourses` from `./selection.mjs`, `processCourse` from `./course-worker.mjs`, `buildStudyReport` from `../persistence/report-builder.mjs`, `StudyMemoStore` from `../persistence/memo.mjs`, `StudyProgress` from `./progress.mjs`. Keep the existing top-level `loadDotenv({quiet:true})` associated with `runStudy` and retain the existing CLI import behavior. Root `study.mjs` is only:

```js
export { filterCoursesByQuery, pickNextLesson } from './learning/selection.mjs';
export { filterLessonsByQuery } from './learning/scheduler.mjs';
export { markPendingLessonWorkFailed, lessonExecutionOrder, processLesson } from './learning/lesson.mjs';
export { buildStudyReport } from './persistence/report-builder.mjs';
export { runStudy } from './learning/run-study.mjs';
```

Keep `report-builder.mjs` importing `filterLessonsByQuery` from `../shared/lesson-filter.mjs`; change `study-cli.mjs` to import `runStudy` from `./learning/run-study.mjs`. The dependency graph is CLI → learning → persistence/platform/assessment/video; persistence imports only shared pure filtering, never learning. Do not adjust the existing abort/cancel/close order.
- [ ] **Step 4: Verify and commit.** Run `node --test test/learning-imports.test.mjs test/study.test.mjs test/study-scheduler.test.mjs test/study-progress.test.mjs test/persistence-imports.test.mjs test/architecture-exports.test.mjs && npm test && npm run check && git diff --check`; expected all pass. Inspect canonical import graph for cycles and imports from root shims. Commit `git add src test && git commit -m "refactor: isolate lesson and worker orchestration"`.

### Task 3: Complete syntax coverage and maintainer documentation

**Files:** Create `scripts/check-syntax.mjs`, `test/architecture-boundaries.test.mjs`; modify `package.json` and `README.md`.

**Interfaces:** `npm run check` recursively checks every `.mjs` under `src/` and preserves nonzero exit code for any syntax failure. README describes canonical modules versus public root shims and where to place future tests.

- [ ] **Step 1: Write a failing recursive-check test.** In `test/architecture-boundaries.test.mjs`, create `src/__syntax-fixture__/broken.mjs` containing `export const = ;` temporarily, run `npm run check` in a child process, and remove the fixture in a `finally` block. Assert the command exits nonzero and mentions `broken.mjs`. Example test body:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
// Run from the project root; the test fixture is always removed in finally.
test('check reaches nested mjs files', async () => {
  const fixture = path.resolve('src/__syntax-fixture__');
  try {
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'broken.mjs'), 'export const = ;\n');
    const result = spawnSync('npm', ['run','check'], { encoding:'utf8', shell:process.platform === 'win32' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /broken\.mjs/);
  } finally { await rm(fixture, { recursive:true, force:true }); }
});
```

Do not run this fixture test concurrently with another syntax check. Before writing the checker, the current flat-list `npm run check` will exit zero (expected red). Add a separate static scan over the five canonical directories rejecting `from '../study.mjs'`, `from '../quiz.mjs'`, `from '../task-point.mjs'`, `from '../study-memo.mjs'`, and any other old-root shim import; canonical-to-canonical imports remain allowed.
- [ ] **Step 2: Implement recursive checker.** Create `scripts/check-syntax.mjs`:

```js
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve('src');
async function visit(dir) {
  for (const entry of (await readdir(dir, { withFileTypes:true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding:'utf8' });
      if (result.status !== 0) {
        console.error(`${file}: ${result.stderr || result.stdout || result.error?.message}`);
        process.exitCode = 1;
      }
    }
  }
}
await visit(root);
```

Change `package.json` `check` to `node scripts/check-syntax.mjs`. Do not change other npm scripts. Run `node --test test/architecture-boundaries.test.mjs`: green.
- [ ] **Step 3: Add README architecture map and verify final state.** Add a concise section documenting `src/platform/`, `src/assessment/`, `src/video/`, `src/learning/`, `src/persistence/`, CLI roots and re-export shims; explain `evaluateAll` isolation and offline regression tests. Run `node --test test/architecture-boundaries.test.mjs && npm test && npm run check && git diff --check`; expected all pass. Check `git status --short` for unwanted fixture files, verify `package.json` CLI script entries unchanged, compare public export-key manifest and JSON fixture from Task 1, and ensure no live command was run. Commit `git add README.md package.json scripts src test && git commit -m "docs: document architecture and check nested modules"`.
