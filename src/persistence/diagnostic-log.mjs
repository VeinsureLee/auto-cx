import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

// 题库没能直接用上的题目：把页面实际抓到的内容追加进日志文件。
//
// 终端输出会被进度条重绘冲掉、复制也容易漏行，而「为什么没匹配上」只能靠现场
// 数据定位——空题干、题型识别成 other、题干把选项也吸进去了，表现都是「未命中」，
// 修法却完全不同。写失败绝不能影响学习流程，因此这里吞掉所有错误。
export async function appendAnswerDiagnostics(filePath, lines) {
  if (!filePath || !Array.isArray(lines) || !lines.length) {
    return false;
  }
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
