import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { readConfig } from "./config.mjs";
import { runStudy } from "./learning/run-study.mjs";
import { writeStudyReport } from "./persistence/study-report.mjs";
export { renderStudyReportMarkdown, writeStudyReport } from "./persistence/study-report.mjs";

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href;

function collectCourseArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--course") {
      const chunk = argv[index + 1];
      if (chunk) {
        values.push(...chunk.split(",").map((item) => item.trim()).filter(Boolean));
      }
      index += 1;
    }
  }
  return values;
}

function collectLessonArgs(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--lesson") {
      const chunk = argv[index + 1];
      if (chunk) {
        values.push(chunk.trim());
      }
      index += 1;
    }
  }
  return values;
}

export function collectPhaseArg(argv) {
  const indexes = argv
    .map((value, index) => (value === "--phase" ? index : -1))
    .filter((index) => index >= 0);
  if (!indexes.length) {
    return null;
  }
  if (indexes.length > 1) {
    throw new Error("--phase 只能指定一次。");
  }
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--phase 需要一个值；目前支持 video。");
  }
  if (!["video", "homework"].includes(value)) {
    throw new Error(`不支持的 --phase 值“${value}”；目前支持 video 或 homework。`);
  }
  return value;
}

export function collectConcurrencyArg(argv, fallback = 1) {
  const indexes = argv
    .map((value, index) => (value === "--concurrency" ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 0) return fallback;
  if (indexes.length > 1) throw new Error("--concurrency 只能指定一次。");
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error("--concurrency 需要一个值。");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error("--concurrency 必须是 1 到 3 之间的整数。");
  }
  return parsed;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const courseArgs = collectCourseArgs(process.argv);
  const lessonArgs = collectLessonArgs(process.argv);
  const phase = collectPhaseArg(process.argv);
  const cliConcurrency = process.argv.includes("--concurrency")
    ? collectConcurrencyArg(process.argv)
    : null;
  const config = readConfig(process.env, process.cwd(), {
    requireCredentials: false,
    ...(cliConcurrency === null ? {} : { studyConcurrencyOverride: cliConcurrency }),
  });
  const concurrency = cliConcurrency ?? config.studyConcurrency;
  const coursesQuery = courseArgs.length ? courseArgs : config.studyCourses;
  const lessonsQuery = lessonArgs.length ? lessonArgs : null;

  if (coursesQuery.length) {
    console.log(`指定课程：${coursesQuery.join("、")}`);
  }
  if (lessonsQuery?.length) {
    console.log(`指定节号：${lessonsQuery.join("、")}`);
  }
  console.log(
    phase === "video"
      ? "自动学习（仅视频阶段）：自然播放并记录断点，不处理章节作业。"
      : phase === "homework"
        ? "自动学习（仅作业阶段）：只作答并提交章节作业，不播放视频。"
        : dryRun
          ? "自动学习（演练模式）：视频照常播放；章节作业只填入答案，不提交。"
          : "自动学习（全自动模式）：逐课节看完视频，再做该课节作业。",
  );
  console.log(`课节并发数：${concurrency}`);

  const report = await runStudy({ dryRun, phase, config, coursesQuery, lessonsQuery, concurrency });
  await writeStudyReport(report, config);

  for (const course of report.courses) {
    console.log(`- ${course.name}`);
    for (const lesson of course.lessons) {
      console.log(
        `  [${lesson.status}] ${lesson.title}（视频 ${lesson.video?.status ?? "—"} / 作业 ${lesson.homework?.status ?? "—"}）${lesson.detail ? ` — ${lesson.detail}` : ""}`,
      );
    }
  }

  console.log(`报告已保存到 ${path.relative(process.cwd(), config.studyReportPath)}。`);
  console.log(`Markdown 报告已保存到 ${path.relative(process.cwd(), config.studyReportMarkdownPath)}。`);
}

if (IS_MAIN) {
  main().catch(async (error) => {
    if (error.studyReport) {
      try {
        const config = readConfig(process.env, process.cwd(), {
          requireCredentials: false,
          studyConcurrencyOverride: 1,
        });
        await writeStudyReport(error.studyReport, config);
        console.error("失败现场已写入学习报告。");
      } catch (reportError) {
        console.error(`失败报告写入失败：${reportError.message}`);
      }
    }
    console.error(`自动学习未完成：${error.message}`);
    process.exitCode = 1;
  });
}
