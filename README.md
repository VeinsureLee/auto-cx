# 超星平台登录自动化

使用 Playwright 驱动本机 Chrome，自动登录北京邮电大学研究生院课程平台、采集未完成课程，并以可恢复的“视频优先、作业后置”两阶段流程完成学习任务。

## 使用方法

1. 复制 `.env.example` 为 `.env`，设置以下变量：

   ```dotenv
   PhoneNumber=你的手机号
   Password=你的密码
   ```

2. 安装依赖并运行：

   ```powershell
   npm install
   npm run login
   ```

   浏览器默认以可视模式运行。若只想在后台执行登录和导航，可设置 `CHAOXING_HEADLESS=true`。

登录成功并进入 `https://i.chaoxing.com/base` 后：

- 未完成课程写入 `artifacts/incomplete-courses.json`；
- 浏览器会话写入 `.auth/chaoxing-storage-state.json`，供后续学习脚本复用。

课程结果包含名称、教师、开课时间、课程 ID、班级 ID、人员 ID、角色、任务点进度和课程链接。带有“课程已结束”标记、位于历史课程区域或任务点进度达到 100% 的课程不会出现在结果中。

默认会打开课程名称包含“科研诚信”的课程，点击“章节”，再打开 `2.1 科学海洋上的高远星空`。程序只进入课节页面，不会自动播放视频。

## 可视化视频播放预览

运行以下命令会打开可见 Chrome、进入目标课节并真实点击一次视频播放按钮：

```powershell
npm run preview:video
```

浏览器默认保留 30 秒供人工检查，然后报告视频是否仍在播放并退出。可通过 `CHAOXING_VIDEO_PREVIEW_SECONDS` 设置 5 到 3600 秒的观察时间。预览模式不会拖动进度、自动续播、伪造页面焦点或绕过离页暂停。

## 课程进度表

运行以下命令会以只读方式打开课程目录，并生成已完成/未完成课节进度表：

```powershell
npm run progress
```

默认使用 `CHAOXING_PROGRESS_CONCURRENCY=2`，同时读取两门课程的目录。并发仅用于读取进度，不会播放视频。浏览器默认可见；设置 `CHAOXING_HEADLESS=true` 可隐藏浏览器。

输出文件：

- `artifacts/course-progress.json`：包含课程、课节、状态和待完成任务点的结构化数据；
- `artifacts/course-progress.md`：便于直接查看的 Markdown 进度表。

## 自动学习（目录筛选 + 逐个听课 + 备忘录）

程序先只读课程目录，挑出“未完成且未被闯关锁定”的课节；然后**逐个课节打开**，自然播放视频到 95%，再做该课节的作业，完成后才打开下一个课节。整个过程只打开有必要的课节，不会挨个点开所有课节（避免触发平台限流）：

```powershell
npm run study
```

`npm run study` 会真实作答并**提交**；如需先演练（只作答、填入但不提交，生成报告核对），运行：

```powershell
npm run study:dry
```

只执行或恢复视频阶段、不进入章节作业：

```powershell
npm run study -- --phase video --course 科研诚信
```

只处理章节作业、不播放视频（作业与视频相互独立）：

```powershell
npm run study -- --phase homework --course 科研诚信
```

只学习指定的课程（测试模式，先小范围验证）——用 `--course` 传课程名称关键字，可重复传多个，也可逗号分隔：

```powershell
npm run study -- --course 创新创业
npm run study:dry -- --course 科研诚信
npm run study:dry -- --course "创新创业基础, 科研诚信"
```

也可以用环境变量 `CHAOXING_STUDY_COURSES=课程关键字（逗号分隔）` 指定；命令行 `--course` 优先于环境变量。留空时默认学习全部未完成课程。

工作方式：

- 从 `artifacts/incomplete-courses.json` 读取所选课程，只读课程目录，按 `knowledgeId` 记录每课节的标题、是否已完成、是否被闯关锁定、待完成任务点数；
- 只挑“未完成且未锁定”的课节，逐个打开；打开一个 → 播视频到 95% → 做作业 → 更新备忘录 → 再打开下一个；
- 视频不会 seek、拖动进度或伪造焦点；达到真实时长的 95% 即记为该课节视频完成；
- 视频播放中弹出的**内嵌测验**会自动作答并提交（这类题不提交视频无法继续，因此即使 `--dry-run` 也会真实提交）；
- 章节作业调用 DeepSeek（默认 `https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`）按严格 JSON 返回答案；仅在**所有题目都拿到答案**时才提交，避免提交垃圾答案；
- `--dry-run` 仍会真实播放视频；章节作业只填答、不提交，并把答案保存到备忘录（`study-memo.json` 的 `homework.lastAnswers`），真提交时复用这些答案、不再重新调模型；
- 真提交时点“提交”后会出现“确认提交？”弹窗，程序会自动点“确定”完成提交；
- 被“闯关”锁定的课节跳过并在备忘录记录；完成前置课节后，下次运行时目录会重新判定解锁；
- 提交结果不确定时，下次先与平台状态对账，结果不明确不会盲目重复提交；
- 不支持的题型（无法判定的填空/简答等）记为 `failed` 并跳过，不强行提交；平台要求验证码时停止并提示人工处理，不会尝试绕过。

需要先在 `.env` 配置 DeepSeek API Key：

```dotenv
CHAOXING_DEEPSEEK_API_KEY=sk-你的key
```

输出文件：

- `artifacts/study-memo.json`：学习备忘录，运行中持续原子写入；每课节记录视频/作业两个完成状态与最后错误；
- `artifacts/study-memo.md`：备忘录的可读 Markdown 表格；
- `artifacts/study-report.json`：每次学习的结构化结果（课程/课节/视频/作业状态）；
- `artifacts/study-report.md`：便于直接查看的 Markdown 报告。

浏览器默认可见运行（平台在页面不可见时可能暂停视频）；也可设置 `CHAOXING_HEADLESS=true`。任务标签、模块帧、视频弹题和章节作业的选择器集中在 `src/study-selectors.mjs`，首次真实运行若与站点 DOM 有出入，可集中在该文件校准。

## 可选设置

- `CHAOXING_HEADLESS=false`：显示浏览器窗口。
- `CHAOXING_BROWSER_CHANNEL=msedge`：改用 Microsoft Edge。
- `CHAOXING_BROWSER_PATH=...`：指定 Chromium 浏览器可执行文件。
- `CHAOXING_NO_SANDBOX=false`：在 root / 无沙箱环境（云服务器、Docker）设为 `true`，等价于给浏览器加 `--no-sandbox`。
- `CHAOXING_TIMEOUT_MS=45000`：调整页面操作及媒体元数据加载的等待超时，范围为 1000 到 300000 毫秒；不会限制视频本身的播放时长。
- `CHAOXING_STORAGE_STATE=...`：修改登录会话保存位置。
- `CHAOXING_COURSES_PATH=...`：修改未完成课程 JSON 的保存位置。
- `CHAOXING_TARGET_COURSE=...`：通过完整名称或唯一关键字选择课程。
- `CHAOXING_TARGET_LESSON=...`：通过完整标题或唯一关键字选择课节。
- `CHAOXING_VIDEO_PREVIEW_SECONDS=30`：设置可视化播放检查时长。
- `CHAOXING_PROGRESS_CONCURRENCY=2`：设置只读进度采集并发数，范围为 1 到 4。
- `CHAOXING_PROGRESS_PATH=...`：修改 JSON 进度文件路径。
- `CHAOXING_PROGRESS_MARKDOWN_PATH=...`：修改 Markdown 进度表路径。
- `CHAOXING_DEEPSEEK_API_KEY=...`：自动答题使用的 DeepSeek API Key（也兼容 `DEEPSEEK_API_KEY`）。
- `CHAOXING_LLM_MODEL=deepseek-chat`：修改自动答题模型。
- `CHAOXING_LLM_BASE_URL=https://api.deepseek.com`：修改 DeepSeek 接口地址。
- `CHAOXING_STUDY_REPORT_PATH=...`：修改学习报告 JSON 路径。
- `CHAOXING_STUDY_REPORT_MARKDOWN_PATH=...`：修改学习报告 Markdown 路径。
- `CHAOXING_STUDY_MEMO_PATH=...`：修改学习备忘录 JSON 路径。
- `CHAOXING_STUDY_MEMO_MARKDOWN_PATH=...`：修改学习备忘录 Markdown 路径。
- `CHAOXING_VIDEO_TARGET_PERCENT=95`：设置自然播放目标百分比，范围 1 到 100。
- `CHAOXING_VIDEO_SPEED=2`：设置视频播放倍速，范围 0.5 到 4，默认 2（二倍速）。
- `CHAOXING_VIDEO_RETRY_LIMIT=3`：设置单个视频每轮重试上限，范围 1 到 10。
- `CHAOXING_STUDY_COURSES=创新创业`：只学习名称包含该关键字的课程（逗号分隔多个）。

`.env`、`.auth/`、`artifacts/` 和依赖目录都已加入 `.gitignore`。程序不会输出手机号、密码或 Cookie；若平台要求验证码，程序会停止并提示人工处理，不会尝试绕过。
