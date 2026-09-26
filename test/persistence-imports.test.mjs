import assert from 'node:assert/strict';
import test from 'node:test';

import { createStudyMemo, refreshCatalog } from '../src/study-memo.mjs';
import { buildStudyReport } from '../src/study.mjs';

test('memo and report builders retain old API bindings', async () => {
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

test('report structure preserves stored statuses and metadata', () => {
  const course = { courseId: 'c', clazzId: 'k', name: 'Course' };
  const now = () => new Date('2026-09-26T00:00:00.000Z');
  const memo = createStudyMemo({ courses: [course], now });
  refreshCatalog(memo, course, [{ knowledgeId: 'L', title: 'Lesson', ordinal: 1, completed: false }], now);
  const report = buildStudyReport({ memo, courseIds: ['c:k'], dryRun: false, generatedAt: now().toISOString() });
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'generatedAt', 'dryRun', 'requestedPhase', 'fatalError', 'courses']);
  assert.deepEqual(Object.keys(report.courses[0].lessons[0]), ['title', 'knowledgeId', 'ordinal', 'status', 'detail', 'video', 'homework']);
  assert.equal(report.courses[0].lessons[0].video.status, 'pending');
  assert.equal(report.courses[0].lessons[0].homework.status, 'pending');
});
