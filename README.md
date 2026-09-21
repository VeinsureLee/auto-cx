# 超星平台登录自动化

使用 Playwright 驱动本机 Chrome，自动登录北京邮电大学研究生院课程平台、进入超星个人空间，并获取尚未结束且任务点未达到 100% 的课程。

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

登录成功并进入 `https://i.chaoxing.com/base` 后：

- 未完成课程写入 `artifacts/incomplete-courses.json`；
- 浏览器会话写入 `.auth/chaoxing-storage-state.json`，供后续学习脚本复用。

课程结果包含名称、教师、开课时间、课程 ID、班级 ID、人员 ID、角色、任务点进度和课程链接。带有“课程已结束”标记、位于历史课程区域或任务点进度达到 100% 的课程不会出现在结果中。

## 可选设置

- `CHAOXING_HEADLESS=false`：显示浏览器窗口。
- `CHAOXING_BROWSER_CHANNEL=msedge`：改用 Microsoft Edge。
- `CHAOXING_BROWSER_PATH=...`：指定 Chromium 浏览器可执行文件。
- `CHAOXING_TIMEOUT_MS=45000`：调整等待超时，范围为 1000 到 300000 毫秒。
- `CHAOXING_STORAGE_STATE=...`：修改登录会话保存位置。
- `CHAOXING_COURSES_PATH=...`：修改未完成课程 JSON 的保存位置。

`.env`、`.auth/`、`artifacts/` 和依赖目录都已加入 `.gitignore`。程序不会输出手机号、密码或 Cookie；若平台要求验证码，程序会停止并提示人工处理，不会尝试绕过。
