# 超星平台登录自动化

使用 Playwright 驱动本机 Chrome，自动登录北京邮电大学研究生院课程平台、进入超星个人空间、获取未完成课程，并打开指定课程中的指定课节。

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

## 自动学习（顺序播放 + 自动答题提交）

运行以下命令会按课程顺序逐个处理未完成课程，在每个课节内按顺序完成任务点：视频真实播放到结束、音频播放到结束、章节测验自动调用 DeepSeek 作答并提交：

```powershell
npm run study
```

`npm run study` 会真实作答并**提交**；如需先演练（只作答、填入但不提交，生成报告核对），运行：

```powershell
npm run study:dry
```

只学习指定的课程（测试模式，先小范围验证）——用 `--course` 传课程名称关键字，可重复传多个，也可逗号分隔：

```powershell
npm run study -- --course 创新创业
npm run study:dry -- --course 科研诚信
npm run study:dry -- --course "创新创业基础, 科研诚信"
```

也可以用环境变量 `CHAOXING_STUDY_COURSES=课程关键字（逗号分隔）` 指定；命令行 `--course` 优先于环境变量。留空时默认学习全部未完成课程。

工作方式：

- 从 `artifacts/incomplete-courses.json` 按顺序读取所有未完成课程，逐门、逐课节推进；
- 视频/音频任务点等待自然播放结束，不会拖动进度、伪造焦点或绕过离页暂停；被平台暂停超过 60 秒的视频记录为 `skipped`，绝不自动续播；
- 章节测验调用 DeepSeek（默认 `https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`）按严格 JSON 返回答案；仅在**所有题目都拿到答案**时才提交，避免提交垃圾答案；
- 被“闯关”锁定的课节会先跳过，完成前置课节后自动解锁；
- 不支持的题型（无法判定的填空/简答等）会记录为 `skipped` 并跳过，不强行提交。

需要先在 `.env` 配置 DeepSeek API Key：

```dotenv
CHAOXING_DEEPSEEK_API_KEY=sk-你的key
```

输出文件：

- `artifacts/study-report.json`：每次学习的结构化结果（课程/课节/任务点状态）；
- `artifacts/study-report.md`：便于直接查看的 Markdown 报告。

浏览器默认可见运行（平台在页面不可见时可能暂停视频）；也可设置 `CHAOXING_HEADLESS=true`。任务点模块帧与“下一任务点”控件的选择器集中在 `src/study-selectors.mjs`，首次真实运行若与站点 DOM 有出入，只需调整该文件。

## 可选设置

- `CHAOXING_HEADLESS=false`：显示浏览器窗口。
- `CHAOXING_BROWSER_CHANNEL=msedge`：改用 Microsoft Edge。
- `CHAOXING_BROWSER_PATH=...`：指定 Chromium 浏览器可执行文件。
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
- `CHAOXING_STUDY_COURSES=创新创业`：只学习名称包含该关键字的课程（逗号分隔多个）。

`.env`、`.auth/`、`artifacts/` 和依赖目录都已加入 `.gitignore`。程序不会输出手机号、密码或 Cookie；若平台要求验证码，程序会停止并提示人工处理，不会尝试绕过。
