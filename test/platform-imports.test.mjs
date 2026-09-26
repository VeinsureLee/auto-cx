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
    const legacy = await import(`../src/${oldName}.mjs`);
    const canonicalModule = await import(`../src/${canonical}.mjs`);
    assert.strictEqual(legacy[symbol], canonicalModule[symbol], symbol);
  }
});
