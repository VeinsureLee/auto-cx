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
