import path from "node:path";
import process from "node:process";

import { detectQuizSubmissionState, handleQuizWork } from "../assessment/chapter-quiz.mjs";
import { homeworkNeedsWork, makeCourseKey, setLessonHomework, setLessonVideo, videoNeedsWork } from "../persistence/memo.mjs";
import { appendAnswerDiagnostics } from "../persistence/diagnostic-log.mjs";
import { clickTaskTab, discoverLessonTasks, waitForTaskSurface } from "../platform/task-manifest.mjs";
import { readTaskPointState } from "../platform/task-point-status.mjs";
import { playManifestVideo } from "../video/runner.mjs";

function homeworkStatusFromResult(result) {
  if (result.status === "answered") return "submitted";
  if (result.status === "dry-run") return "dry_run";
  if (result.uncertain || (result.submissionStarted && result.status === "error")) {
    return "uncertain";
  }
  return "failed";
}

function taskKeyOf(task) {
  return task?.key ?? task?.taskKey ?? null;
}

function addCompletedTaskKeys(progress, task) {
  const key = taskKeyOf(task);
  const keys = Array.isArray(progress?.completedTaskKeys) ? progress.completedTaskKeys : [];
  return key == null || keys.includes(key) ? keys : [...keys, key];
}

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
  if (!record) {
    throw new Error(`备忘录中不存在课节 ${lesson.knowledgeId ?? lesson.title ?? ""}。`);
  }
  if (phase !== "homework" && videoNeedsWork(record.video)) {
    setLessonVideo(memo, course, lesson, { status: "failed", lastError: detail }, now);
  }
  if (phase !== "video" && homeworkNeedsWork(record.homework, { submitDryRun: true })) {
    setLessonHomework(memo, course, lesson, { status: "failed", lastError: detail }, now);
  }
  return record;
}

export function lessonExecutionOrder({ phase, homeworkResult, videoTaskCount }) {
  if (phase === "video") return ["video"];
  if (phase === "homework") return ["homework"];
  if (!homeworkResult.success) return ["homework", "blocked-video"];
  return ["homework", ...(videoTaskCount ? ["video"] : [])];
}

async function playVideoTask({
  page,
  course,
  lesson,
  task,
  taskKey = taskKeyOf(task),
  store,
  config,
  now,
  progress,
  slot,
  taskPointReader = null,
  completionSyncTimeoutMs,
}) {
  progress.stage(slot, { name: "video", taskTitle: task.title, detail: "正在打开视频" });

  try {
    await clickTaskTab(page, task);
  } catch (error) {
    await store.mutate((state) =>
      setLessonVideo(state, course, lesson, { status: "failed", lastError: error.message ?? String(error) }, now),
    );
    return false;
  }

  const surface = await waitForTaskSurface(page, config.timeoutMs, "video", task.title);
  if (!surface) {
    await store.mutate((state) =>
      setLessonVideo(state, course, lesson, { status: "failed", lastError: `视频“${task.title}”未加载出可见内容` }, now),
    );
    return false;
  }

  try {
    await playManifestVideo({
      frame: surface.frame,
      config,
      readTaskPoint: taskPointReader,
      completionSyncTimeoutMs,
      onProgress: async (state, { targetSeconds }) => {
        // 任务点状态与媒体百分比分开上报：媒体播到 100% 不代表任务点已完成。
        let taskPointState = null;
        if (taskPointReader) {
          try {
            taskPointState = (await taskPointReader())?.state ?? null;
          } catch {
            taskPointState = null;
          }
        }
        progress.video(slot, {
          currentTime: state.currentTime,
          duration: state.duration,
          targetSeconds,
          speed: config.videoSpeed,
          taskPointState,
        });
      },
      onPopupQuiz: async (result) => {
        progress.stage(slot, {
          name: "video-quiz",
          taskTitle: task.title,
          detail: result.detail ?? (result.status === "handling" ? "正在处理视频弹题" : "视频弹题已处理"),
        });
      },
    });
    await store.mutate((state) =>
      setLessonVideo(
        state,
        course,
        lesson,
        { status: "pending", lastError: null, completedTaskKeys: addCompletedTaskKeys(state.courses
          .find((candidate) => makeCourseKey(candidate) === makeCourseKey(course))?.lessons
          .find((candidate) => String(candidate.knowledgeId) === String(lesson.knowledgeId))?.video, task) },
        now,
      ),
    );
    return true;
  } catch (error) {
    await store.mutate((state) =>
      setLessonVideo(
        state,
        course,
        lesson,
        { status: error.blocked ? "blocked" : "failed", lastError: error.message ?? String(error) },
        now,
      ),
    );
    return false;
  }
}

function isDetachedError(error) {
  return /detached|closed|target page/i.test(error?.message ?? String(error ?? ""));
}

const HOMEWORK_MAX_ATTEMPTS = 3;

async function handleHomeworkTask({
  page,
  course,
  lesson,
  memoLesson,
  task,
  taskKey = taskKeyOf(task),
  store,
  config,
  dryRun,
  now,
  progress,
  slot,
}) {
  try {
    await clickTaskTab(page, task);
  } catch (error) {
    await store.mutate((state) =>
      setLessonHomework(state, course, lesson, { status: "failed", lastError: error.message ?? String(error) }, now),
    );
    return false;
  }

  // 试错表：记录被判错、要求重答的答案组合，下次让大模型避开这些答案。
  const trials = Array.isArray(memoLesson.homework?.trials)
    ? memoLesson.homework.trials.slice()
    : [];
  const savedAnswers = memoLesson.homework?.lastAnswers ?? null;

  progress.stage(slot, { name: "homework", taskTitle: task.title, detail: "正在读取作业" });

  let attempts = 0;
  while (attempts < HOMEWORK_MAX_ATTEMPTS) {
    const surface = await waitForTaskSurface(page, config.timeoutMs, "assessment", task.title);
    if (!surface) {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: `作业“${task.title}”未加载出可见内容`, trials }, now),
      );
      return false;
    }

    let platformState;
    try {
      platformState = await detectQuizSubmissionState(surface.frame);
    } catch (error) {
      if (isDetachedError(error)) {
        await page.waitForTimeout(1_500);
        continue;
      }
      platformState = "unknown";
    }

    // 演练点过「暂时保存」的草稿，平台会把这道题也显示成已提交，但那是草稿不是真
    // 提交。这种课节照常重新作答（正式运行会真正提交），否则草稿永远覆盖不掉。
    // 「目录已完成」的章节不会走到这里 —— 候选阶段就排除了。
    const draftOnly = memoLesson.homework?.status === "dry_run";
    if (platformState === "submitted" && !draftOnly) {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, {
          status: "pending",
          lastError: null,
          trials,
          completedTaskKeys: addCompletedTaskKeys(state.courses
            .find((candidate) => makeCourseKey(candidate) === makeCourseKey(course))?.lessons
            .find((candidate) => String(candidate.knowledgeId) === String(lesson.knowledgeId))?.homework, task),
        }, now),
      );
      return true;
    }
    if (platformState === "captcha") {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: "平台要求验证码，请人工完成提交", trials }, now),
      );
      return false;
    }
    if (memoLesson.homework?.status === "uncertain" && platformState === "unknown" && !dryRun) {
      await store.mutate((state) =>
        setLessonHomework(
          state,
          course,
          lesson,
          { status: "uncertain", lastError: "上次提交结果仍无法与平台对账，未盲目重复提交", trials },
          now,
        ),
      );
      return false;
    }

    let result;
    try {
      progress.stage(slot, { name: "homework", taskTitle: task.title, detail: "正在生成并填写答案" });
      result = await handleQuizWork({
        frame: surface.frame,
        page,
        config,
        dryRun,
        // 第一次尝试优先用本地题库与 dry-run 保存的答案；重试时由大模型结合试错表重新生成。
        fallbackAnswers: attempts === 0 && !dryRun ? savedAnswers : null,
        questionBank: config.questionBank ?? null,
        trials,
        beforeSubmit: async () => {
          progress.stage(slot, { name: "homework", taskTitle: task.title, detail: "正在提交作业" });
        },
      });
    } catch (error) {
      if (isDetachedError(error)) {
        await page.waitForTimeout(1_500);
        continue;
      }
      result = { status: "error", detail: error.message ?? String(error) };
    }

    // 题库没能直接用上的题，把页面实际抓到的内容写进诊断日志：题干为空、题型识别
    // 不出来、题干被换字，表现都是「没命中题库」，但修法完全不同，只有现场数据能
    // 分辨。终端会被进度条重绘冲掉，所以明细一律落盘，屏幕上只留一行指路。
    if (attempts === 0 && Array.isArray(result.diagnostics) && result.diagnostics.length) {
      progress.log(
        `      题库未命中 ${result.diagnostics.length} 题，现场明细见 ${path.relative(process.cwd(), config.answerLogPath) || config.answerLogPath}`,
      );
    }
    if (Array.isArray(result.diagnostics) && result.diagnostics.length) {
      await appendAnswerDiagnostics(config.answerLogPath, [
        `[${new Date().toISOString()}] ${course.name} / ${lesson.title} / ${task.title}（第 ${attempts + 1} 次作答）`,
        ...result.diagnostics.flatMap((item) => {
          const reason = item.matched
            ? "题干已命中题库，但题型或选项对不上"
            : item.nearestStem
              ? `题库最相近「${item.nearestStem}」相似度 ${item.similarity.toFixed(2)}`
              : "题库里没有同题型的条目可比";
          return [
            `  第${item.index}题[${item.type}] 选项${item.optionCount}个｜题干${item.stem.length}字「${item.stem || "（空）"}」｜${reason}`,
            ...(item.options.length
              ? [`    选项：${item.options.map((text) => `「${text}」`).join(" ")}`]
              : []),
          ];
        }),
      ]);
    }

    if (result.reanswer) {
      // 本次答案被判错：记入试错表，换一组答案重试。
      if (Array.isArray(result.answers)) {
        trials.push(result.answers);
      }
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, { status: "failed", lastError: result.detail, trials }, now),
      );
      if (attempts + 1 < HOMEWORK_MAX_ATTEMPTS) {
        progress.stage(slot, {
          name: "homework-retry",
          taskTitle: task.title,
          detail: `第 ${attempts + 2}/${HOMEWORK_MAX_ATTEMPTS} 次尝试`,
        });
      }
      attempts += 1;
      await page.waitForTimeout(1_500);
      continue;
    }

    const status = homeworkStatusFromResult(result);
    const patch = {
      status: ["submitted", "dry_run"].includes(status) ? "pending" : status,
      lastError: ["submitted", "dry_run"].includes(status) ? null : result.detail,
      trials,
    };
    const taskSucceeded = ["submitted", "dry_run"].includes(status);
    if (taskSucceeded && result.detail) {
      progress.log(`      作业“${task.title}”${result.detail}`);
    }
    if (["submitted", "dry_run"].includes(status) && Array.isArray(result.answers)) {
      patch.lastAnswers = result.answers;
    }
    await store.mutate((state) => {
      if (taskSucceeded) {
        patch.completedTaskKeys = addCompletedTaskKeys(state.courses
          .find((candidate) => makeCourseKey(candidate) === makeCourseKey(course))?.lessons
          .find((candidate) => String(candidate.knowledgeId) === String(lesson.knowledgeId))?.homework, task);
      }
      return setLessonHomework(state, course, lesson, patch, now);
    });
    return status === "submitted" || status === "dry_run";
  }

  await store.mutate((state) =>
    setLessonHomework(
      state,
      course,
      lesson,
      { status: "failed", lastError: "多次重答仍被要求重做，请人工处理", trials },
      now,
    ),
  );
  return false;
}

export async function processLesson({
  page,
  course,
  lesson,
  memoLesson,
  store,
  config,
  dryRun,
  phase,
  now,
  progress,
  slot,
  deps = {},
}) {
  const {
    discoverTasks = discoverLessonTasks,
    runHomeworkTask = handleHomeworkTask,
    runVideoTask = playVideoTask,
  } = deps;

  const { tasks, surfaceFailure } = await discoverTasks({
    page,
    course,
    lesson,
    timeoutMs: config.timeoutMs,
  });
  if (surfaceFailure) {
    progress.log(`      ⚠ ${surfaceFailure}`);
  }

  // 无任务标签时持久化失败：绝不误标 none 后把课节报告为完成。
  if (tasks.length === 0) {
    const detail = surfaceFailure ?? "课节页面中未发现任务标签";
    await store.mutate((state) =>
      markPendingLessonWorkFailed(state, course, lesson, { phase, detail, now }),
    );
    return { status: "failed", detail };
  }

  const videoTasks = tasks.filter((task) => task.kind === "video");
  const homeworkTasks = tasks.filter((task) => task.kind === "assessment");
  const videoCompleted = new Set(memoLesson.video?.completedTaskKeys ?? []);
  const homeworkCompleted = new Set(memoLesson.homework?.completedTaskKeys ?? []);
  const allTasksCompleted = (taskList, completed) =>
    taskList.every((task) => {
      const key = taskKeyOf(task);
      return key != null && completed.has(key);
    });
  const persistTaskSuccess = async (kind, task, status = "pending") => {
    const key = taskKeyOf(task);
    if (key == null) return;
    const completed = kind === "video" ? videoCompleted : homeworkCompleted;
    if (completed.has(key)) return;
    completed.add(key);
    await store.mutate((state) => {
      const setter = kind === "video" ? setLessonVideo : setLessonHomework;
      return setter(state, course, lesson, {
        status,
        completedTaskKeys: [...completed],
      }, now);
    });
  };

  if (videoTasks.length === 0 && memoLesson.video?.status !== "none") {
    await store.mutate((state) =>
      setLessonVideo(state, course, lesson, { status: "none", lastError: null }, now),
    );
  }
  if (homeworkTasks.length === 0 && memoLesson.homework?.status !== "none") {
    await store.mutate((state) =>
      setLessonHomework(state, course, lesson, { status: "none", lastError: null }, now),
    );
  }

  // 作业门：正常/试跑模式先完成全部作业；失败立即短路，不播放本课节视频。
  // --phase video 显式跳过作业门。
  let homeworkResult = { success: true, detail: null };
  if (
    phase !== "video" &&
    homeworkTasks.length > 0 &&
    homeworkNeedsWork(memoLesson.homework, { submitDryRun: !dryRun })
  ) {
    for (const task of homeworkTasks) {
      if (homeworkCompleted.has(taskKeyOf(task))) continue;
      const ok = await runHomeworkTask({
        page,
        course,
        lesson,
        memoLesson,
        task,
        taskKey: taskKeyOf(task),
        store,
        config,
        dryRun,
        now,
        progress,
        slot,
      });
      if (!ok) {
        homeworkResult = { success: false, detail: `作业“${task.title}”处理失败` };
        break;
      }
      await persistTaskSuccess("homework", task);
    }
    if (homeworkResult.success && allTasksCompleted(homeworkTasks, homeworkCompleted)) {
      await store.mutate((state) =>
        setLessonHomework(state, course, lesson, {
          status: dryRun ? "dry_run" : "submitted",
          lastError: null,
          completedTaskKeys: [...homeworkCompleted],
        }, now),
      );
    }
  }
  if (!homeworkResult.success) {
    return { status: "failed", detail: homeworkResult.detail };
  }

  // 作业门通过后按清单顺序逐个播放视频；首个失败即短路。
  const order = lessonExecutionOrder({ phase, homeworkResult, videoTaskCount: videoTasks.length });
  if (order.includes("video") && videoNeedsWork(memoLesson.video)) {
    for (const task of videoTasks) {
      if (videoCompleted.has(taskKeyOf(task))) continue;
      const taskPointReader = () => readTaskPointState(page, task);
      const ok = await runVideoTask({
        page,
        course,
        lesson,
        task,
        taskKey: taskKeyOf(task),
        store,
        config,
        now,
        progress,
        slot,
        taskPointReader,
        // 可选配置：缺省时沿用 waitForMediaTaskCompletion 默认同步窗口。
        completionSyncTimeoutMs: config.completionSyncTimeoutMs,
      });
      if (!ok) {
        return { status: "failed", detail: `视频“${task.title}”处理失败` };
      }
      await persistTaskSuccess("video", task);
    }
    if (allTasksCompleted(videoTasks, videoCompleted)) {
      await store.mutate((state) =>
        setLessonVideo(state, course, lesson, {
          status: "done",
          lastError: null,
          completedTaskKeys: [...videoCompleted],
        }, now),
      );
    }
  }

  return { status: "done" };
}
