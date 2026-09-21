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

## 可选设置

- `CHAOXING_HEADLESS=false`：显示浏览器窗口。
- `CHAOXING_BROWSER_CHANNEL=msedge`：改用 Microsoft Edge。
- `CHAOXING_BROWSER_PATH=...`：指定 Chromium 浏览器可执行文件。
- `CHAOXING_TIMEOUT_MS=45000`：调整等待超时，范围为 1000 到 300000 毫秒。
- `CHAOXING_STORAGE_STATE=...`：修改登录会话保存位置。
- `CHAOXING_COURSES_PATH=...`：修改未完成课程 JSON 的保存位置。
- `CHAOXING_TARGET_COURSE=...`：通过完整名称或唯一关键字选择课程。
- `CHAOXING_TARGET_LESSON=...`：通过完整标题或唯一关键字选择课节。
- `CHAOXING_VIDEO_PREVIEW_SECONDS=30`：设置可视化播放检查时长。

`.env`、`.auth/`、`artifacts/` 和依赖目录都已加入 `.gitignore`。程序不会输出手机号、密码或 Cookie；若平台要求验证码，程序会停止并提示人工处理，不会尝试绕过。
