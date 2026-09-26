# Source Architecture 2: Assessment and Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate chapter assessment, video-popup quizzes, LLM requests, media playback and video preview into focused modules, retaining all old imports and behavior.

**Architecture:** Canonical modules live under `src/assessment/` and `src/video/`; root entry modules are re-export shims. The chapter and popup portions of `quiz.mjs` are separated at its existing marker with their original function bodies.

**Tech Stack:** Node.js >=20 ES modules, node:test, playwright-core offline fakes.

**Spec:** `docs/superpowers/specs/2026-09-26-source-architecture-maintainability-design.md`

## Global Constraints

- Complete platform plan `2026-09-26-source-architecture-1-platform.md` first; its `src/platform/` and `src/persistence/progress-format.mjs` are available.
- Pure refactor: unchanged flags/text, selectors, prompts, API destination, question/answer shape, retries, timing, task completion and order, data schema, errors and privacy.
- Keep old root module paths and named exports. Browser callbacks cannot close over Node helpers; retain the serialized-callback fixture.
- No live platform login/study/submit/playback or real LLM requests. Use offline tests and `npm test && npm run check && git diff --check` at each task boundary.

## File map

- Create `src/assessment/answerer.mjs` from `src/answerer.mjs` (prompt and DeepSeek interface).
- Create `src/assessment/chapter-quiz.mjs` from the chapter portion of `src/quiz.mjs` (`normalizeOptionText` through `handleQuizWork`); create `src/assessment/video-popup.mjs` from its video quiz portion (after `// —— 视频播放中弹出的内嵌测验 ——`).
- Create `src/video/{media,runner,preview}.mjs` from `src/{task-point,video-runner,video-preview}.mjs`.
- Modify `src/{answerer,quiz,task-point,video-runner,video-preview}.mjs` into old-path export shims. Update `src/login.mjs` preview import and canonical cross-module imports. Add `test/assessment-imports.test.mjs`, `test/video-imports.test.mjs`.

### Task 1: Separate LLM answerer and chapter versus popup quiz

**Files:** Create the three assessment modules and `test/assessment-imports.test.mjs`; modify root `src/answerer.mjs`, `src/quiz.mjs`, `src/video-runner.mjs` (popup import only).

**Interfaces:** `assessment/answerer.mjs` exports existing six answerer functions; `assessment/chapter-quiz.mjs` exports the ten existing chapter quiz functions (`classifyQuestionType`, `collectQuestions`, `detectQuizSubmissionState`, `fillAnswers`, `handleQuizWork`, `mapQType`, `normalizeOptionLabel`, `normalizeOptionText`, `normalizeQuestionStem`, `shouldSubmit`); `assessment/video-popup.mjs` exports `isVideoQuizVisible`, `handleVideoQuizWork`. Root quiz re-exports both. No new arguments or return values.

- [ ] **Step 1: Write a failing import identity and offline quiz behavior test.** `test/assessment-imports.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
test('assessment canonical exports keep old bindings', async () => {
  const oldAnswerer = await import('../src/answerer.mjs');
  const newAnswerer = await import('../src/assessment/answerer.mjs');
  const oldQuiz = await import('../src/quiz.mjs');
  const chapter = await import('../src/assessment/chapter-quiz.mjs');
  const popup = await import('../src/assessment/video-popup.mjs');
  assert.strictEqual(oldAnswerer.buildPrompt, newAnswerer.buildPrompt);
  assert.strictEqual(oldQuiz.collectQuestions, chapter.collectQuestions);
  assert.strictEqual(oldQuiz.handleQuizWork, chapter.handleQuizWork);
  assert.strictEqual(oldQuiz.handleVideoQuizWork, popup.handleVideoQuizWork);
});
```

Run `node --test test/assessment-imports.test.mjs`; expected red: `ERR_MODULE_NOT_FOUND` for the new module.
- [ ] **Step 2: Move LLM implementation verbatim.** `git mv src/answerer.mjs src/assessment/answerer.mjs`; create `src/answerer.mjs` with `export * from './assessment/answerer.mjs';`. Keep fetch payload, auth header, temperature and retry/error behavior unchanged.
- [ ] **Step 3: Separate the original `quiz.mjs` without restructuring logic.** Move it to `src/assessment/chapter-quiz.mjs`; transfer the original block starting at `// —— 视频播放中弹出的内嵌测验 ——` through EOF into `src/assessment/video-popup.mjs`; remove that block from chapter-quiz. The popup module begins:

```js
import { STUDY_SELECTORS } from '../platform/selectors.mjs';
// Then copy the original video quiz block including collectVideoQuizQuestions,
// clickVideoQuizOption, isVideoQuizVisible, waitForVideoQuizClosed, handleVideoQuizWork.
```

The chapter module imports selectors from `../platform/selectors.mjs` and `answerQuestions` from `./answerer.mjs`. Retain the chapter module's existing local helpers and browser callback bodies; leave popup helpers local to popup. Root `src/quiz.mjs`:

```js
export * from './assessment/chapter-quiz.mjs';
export { isVideoQuizVisible, handleVideoQuizWork } from './assessment/video-popup.mjs';
```

`src/video-runner.mjs` imports popup functions from `./assessment/video-popup.mjs` until its own move in Task 2.
- [ ] **Step 4: Verify and commit.** Run `node --test test/assessment-imports.test.mjs test/quiz.test.mjs test/answerer.test.mjs test/architecture-exports.test.mjs && npm test && npm run check && git diff --check`; expected all pass, including the callback-serialization fixture. Commit `git add src test && git commit -m "refactor: isolate assessment and video popup flows"`.

### Task 2: Separate media, video runner, and preview

**Files:** Create `src/video/{media,runner,preview}.mjs`, `test/video-imports.test.mjs`; modify root `src/{task-point,video-runner,video-preview}.mjs` and `src/login.mjs`.

**Interfaces:** Preserve all exports of root `task-point.mjs`, `video-runner.mjs`, `video-preview.mjs` and their function identities. Canonical runner imports `handleVideoQuizWork` and `isVideoQuizVisible` from `../assessment/video-popup.mjs`, and media functions from `./media.mjs`.

- [ ] **Step 1: Write failing canonical-import test.** `test/video-imports.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
test('video canonical exports keep old bindings', async () => {
  for (const [oldName, nextName, symbol] of [
    ['task-point','media','waitForMediaTaskCompletion'],
    ['task-point','media','startMediaPlayback'],
    ['video-runner','runner','playManifestVideo'],
    ['video-preview','preview','startVideoPreview'],
  ]) {
    const oldModule = await import(`../src/${oldName}.mjs`);
    const nextModule = await import(`../src/video/${nextName}.mjs`);
    assert.strictEqual(oldModule[symbol], nextModule[symbol]);
  }
});
```

Run `node --test test/video-imports.test.mjs`; expected `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 2: Move existing function bodies using `git mv`.** `task-point.mjs` → `video/media.mjs`; `video-runner.mjs` → `video/runner.mjs`; `video-preview.mjs` → `video/preview.mjs`. For each original root path recreate a single `export * from './video/<new-name>.mjs';` shim. In runner replace original relative imports with:

```js
import { handleVideoQuizWork, isVideoQuizVisible } from '../assessment/video-popup.mjs';
import { startMediaPlayback, waitForMediaTaskCompletion } from './media.mjs';
```

In `src/login.mjs`, use `./video/preview.mjs`. Do not modify media poll intervals, UI or preview timers.
- [ ] **Step 3: Verify and commit.** Run `node --test test/video-imports.test.mjs test/video-runner.test.mjs test/task-point.test.mjs test/architecture-exports.test.mjs && npm test && npm run check && git diff --check`; inspect `rg -n 'from ' src/video src/assessment` for imports pointing to root shims (none allowed). Commit `git add src test && git commit -m "refactor: isolate video playback and preview"`.
