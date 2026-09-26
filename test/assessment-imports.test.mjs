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
