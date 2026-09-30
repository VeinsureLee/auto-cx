# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

超星（学习通）平台学习自动化工具。用 Playwright 驱动本机 Chrome 登录北京邮电大学研究生院课程平台，采集未完成课程，按“先考核、后视频”的顺序以可恢复的方式完成学习任务；章节作业由 DeepSeek 作答。Node >= 20，ESM（`"type": "module"`），唯一运行时依赖是 `playwright-core` 与 `dotenv`。

`README.md` 是面向使用者的完整文档（命令、全部环境变量、状态语义），改动 CLI 契约或新增环境变量时必须同步更新它。

## 常用命令

```bash
npm install

# 需要真实凭据的操作（会登录真实平台，勿在测试中使用）
npm run login                 # 登录 + 采集未完成课程 → artifacts/incomplete-courses.json
npm run login -- --preview-video   # 或 npm run preview:video：可视化播放预览
npm run progress              # 只读采集课程进度表

# 自动学习（会真实作答并提交）
npm run study
npm run study -- --dry-run            # == npm run study:dry，作业只填不交
npm run study -- --phase video --course 科研诚信
npm run study -- --phase homework --course 科研诚信
npm run study -- --course 创新创业 --lesson "1.1,1.2,1.3" --concurrency 3

# 检查（离线，不登录、不操作真实课程）
npm test                      # node --test，跑 test/*.test.mjs
node --test test/quiz.test.mjs        # 跑单个测试文件
node --test --test-name-pattern "pickNextLesson"   # 按测试名过滤
npm run check                 # node scripts/check-syntax.mjs：递归 node --check src 下所有 .mjs
git diff --check              # 架构重构时也要求跑这一项
```

`npm test` 与 `npm run check` 是本仓库的验收门槛，改动页面抓取后必须两者都过。

## 关键约束

- **契约保持**：`--dry-run` / `--phase` 例外、考核门控、备忘录与报告的结构和字段名、状态取值、默认文件路径、CLI 参数与控制台输出，都视为已冻结的对外契约。重构不得顺带“修”功能问题——若某个移动暴露出无法在不改行为的前提下保留的依赖，先停下提问。
- **浏览器回调必须自包含**：所有 `page.evaluate` / `evaluateAll` 回调在浏览器上下文中被序列化执行，不能引用 Node 模块作用域的变量、常量或 import 的辅助函数。`test/quiz.test.mjs` 用 `Function("callback", …, "return (" + callback.toString() + ")(…)")` 复现这一隔离来守住该边界。
- **选择器集中校准**：站点 DOM 与预期不符时，只改 `src/platform/selectors.mjs`（`STUDY_SELECTORS`），不要在调用点散改。
- **平台对题干做了字体反爬**：作业作答页的题干在浏览器里显示正常，但 DOM 取回来是一串生僻字（步→唭、为→惟、在→唰，同题内替换一致、只换字不改长度），**选项文本是干净的**。混淆是**按题随机**的：有的题题干和选项都干净，有的全被换字；同一题内换字一致。因此题库匹配按四级走：题干精确匹配 → 选项文本集合指纹 → 同章节+同题型+同题干长度对齐 → 选项也被混淆时用题干换字表验证选项顺序后按位置取答案。后两级是推断，必须唯一/可验证，且都会写进日志。不要在不知道这条的前提下「放宽」题干匹配——题干文字本身不可信。
- **答案优先级**：章节作业的答案来源固定为 **本地题库 > dry-run 存档（`homework.lastAnswers`）> DeepSeek**。只有判定为 100% 正确（该题得分达到该次作业每题满分，容差 0.15）的题库答案才可直接使用；答错或半对的题库答案只作为「已判定错误」进入当次提示词，不得写进备忘录的试错表。某题被平台判错后，该题必须降级问模型——题库是确定性的，否则重答循环会一直提交同一个错误答案直到课节失败。
- **不要给 `assessment/answerer.mjs`、`assessment/chapter-quiz.mjs` 新增具名导出**：`test/architecture-exports.test.mjs` 用精确的导出名单锁定了根目录兼容薄壳（它们是 `export *` 转发），新增导出会让它失败。新模块不要把兼容薄壳加到根目录。
- **隐私**：不输出手机号、密码、Cookie；平台要求验证码时程序停止并提示人工处理，不得尝试绕过。
- 真实运行时浏览器默认**可见**——页面隐藏时平台会暂停视频；`CHAOXING_HEADLESS=true` 主要用于登录或只读场景。

## 架构

CLI 入口是根目录的 `src/login.mjs`、`src/progress-cli.mjs`、`src/study-cli.mjs`（仅这三个保持可执行）。其余 `src/*.mjs` 都是**纯 re-export 兼容薄壳**（`answerer`、`quiz`、`study-memo`、`study-selectors`、`task-manifest`、`video-runner` 等）：只为保住既有导入路径，**不得新增业务逻辑，也不得被内部代码反向 import**。新代码导入各领域下的真实实现。

分域（`src/` 下）：

- `platform/`：选择器、课程与课节导航、目录发现、任务标签/模块帧识别、任务点 DOM 状态。不依赖 learning/assessment/video/persistence。
- `assessment/`：章节题读取与填答提交、视频内嵌弹题、DeepSeek 提示词与响应解析、本地题库解析与判定（`question-bank.mjs` 是纯函数模块，文件读取在 `learning/run-study.mjs`，解析结果挂在 `config.questionBank` 上随参数链下传）。
- `video/`：媒体状态观察、自然播放完成判定、视频任务执行与预览。
- `learning/`：课节工作流、并发调度、浏览器页面归属与终端进度。
- `persistence/`：备忘录 schema 与原子写、报告构造与 Markdown 渲染。可依赖纯数据辅助函数，但**不得触碰 Playwright**。
- `shared/`：无平台依赖的课节筛选等纯逻辑。

依赖方向：`CLI → learning 编排 → platform / assessment / video / persistence`。`test/architecture-boundaries.test.mjs` 会强制两件事——canonical 模块不得 import 根目录薄壳，且模块图不得存在循环 import；违反即测试失败。

### 运行时数据流

`study-cli.mjs` 解析参数与 `--dry-run`/`--phase`/`--concurrency`，`readConfig()` 合并环境变量（CLI 优先）→ `runStudy()`（`learning/run-study.mjs`）读取并解析本地题库（`CHAOXING_QUESTION_BANK_PATH`，缺文件则空题库）、加载选中课程、开一个浏览器 context，逐课程调 `processCourse()` → `course-worker.mjs` 用 `runDynamicWorkerPool`（`learning/scheduler.mjs`）为每个课节调度一个**独立页面**：每次取候选前**重新只读课程目录**（`openCourseCatalog` + `refreshCatalog`）以拿到最新解锁状态，再 `selectEligibleLessons` 挑“未完成、未被闯关锁定、备忘录仍需要工作”的课节 → `processLesson()`（`learning/lesson.mjs`）按 `lessonExecutionOrder` 执行：先章节考核，通过后才按目录顺序播放视频；失败则记 `blocked` 并跳过视频。

备忘录 `artifacts/study-memo.json` 是断点续学的唯一事实来源：运行中持续原子写入，按课节记录 video / homework 两个状态与最后错误；提交结果不确定记 `uncertain`，下次先与平台状态对账再决定，不盲目重复提交。`videoNeedsWork` / `homeworkNeedsWork` 决定“是否还需要做”。

用 `--lesson` 指定节号时，`run-study.mjs` 会为 memo/report 派生带后缀的独立文件路径，避免多进程并发互相覆盖。

### 其他约定

- DeepSeek 配置来自 `CHAOXING_DEEPSEEK_API_KEY`（兼容 `DEEPSEEK_API_KEY`），缺失时 `study` 直接报错退出。
- `--dry-run` 仍会真实播放视频，且**视频内嵌弹题照真实提交**（不提交则视频无法继续）；只有章节作业是“只填不交”——填完点平台提交按钮旁的「暂时保存」把草稿留在平台，找不到该按钮不是失败。dry-run 同样会查题库，因此演练阶段就能看到真实会提交的答案。
- **目录已完成的课节一律不重做**：`lessonNeedsWork` / `selectEligibleLessons` 都以此为准（演练点过「暂时保存」的草稿会让平台把该课节算作已完成，同样不回头覆盖）。唯一的例外在 `handleHomeworkTask`：课节本身仍需工作时（尚未完成），若平台把这道题显示成「已提交」而本地记录是 `dry_run` 草稿，那是草稿不是真提交，必须照常重新作答——否则草稿永远覆盖不掉。
- 视频以自然播放推进，倍速默认 2（`CHAOXING_VIDEO_SPEED`），不 seek、不拖进度、不伪造页面焦点。
- `src/learning/progress.mjs` 的 `StudyProgress` 负责每页一条终端进度条、TTY 检测与 SIGINT 时关闭浏览器。

## 文档

`docs/superpowers/specs/` 与 `docs/superpowers/plans/` 保存历次设计说明与实施计划（两阶段学习、考核先行、并发听课、源码架构重构）。涉及这些领域的改动，先读对应 spec——它是行为决策的依据，架构 spec 明确记录了“行为保持不变的重构”的验收标准。
