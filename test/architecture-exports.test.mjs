import assert from 'node:assert/strict';
import test from 'node:test';

// Public top-level module contracts at the start of the source reorganization.
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

test('existing import paths retain their named exports', async () => {
  for (const [moduleName, expected] of Object.entries(EXPECTED_EXPORTS)) {
    assert.deepEqual(Object.keys(await import(`../src/${moduleName}.mjs`)).sort(), expected, moduleName);
  }
});
