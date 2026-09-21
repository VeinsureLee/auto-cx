// 自动学习相关选择器的集中地。
// 首次真实运行发现 DOM 与预期不符时，只需调整本文件中的选择器。

export const STUDY_SELECTORS = {
  // 课程目录
  chapterNav: 'a[data-url*="/mycourse/studentcourse"]',
  lessonItem: ".chapter_item:has(.catalog_name.newCatalog_name a.clicktitle)",
  lessonLink: ".catalog_name.newCatalog_name a.clicktitle",

  // 任务点模块帧路径识别（URL pathname 包含即视为该类型）
  moduleFrames: [
    { type: "video", path: "/ananas/modules/video/index.html" },
    { type: "audio", path: "/ananas/modules/audio/index.html" },
    { type: "quiz", path: "/mooc-ans/work/doHomeWorkNew" },
    { type: "quiz", path: "/ananas/modules/work/index.html" },
    { type: "doc", path: "/ananas/modules/document/" },
    { type: "other", path: "/ananas/modules/insertimage/" },
  ],

  // 前进到下一个任务点的候选策略（按顺序尝试）
  taskPointList: ["#task-list li", ".taskPointList li"],
  nextButton: [
    ".nextBtn",
    ".nextbutton",
    "#nextBtn",
    'button:has-text("下一任务")',
    'button:has-text("下一节")',
    'button:has-text("下一步")',
    'a:has-text("下一任务")',
    'a:has-text("下一节")',
  ],

  // 文档等任务点可点的“已完成/记已学”按钮
  markViewedButton: [".finishStudy", 'button:has-text("已完成")', 'a:has-text("已完成")'],

  // 章节测验（作业）页面
  quiz: {
    questionBlock: ".TiMu",
    stem: ".Zy_TItle",
    optionItem: ".answerBg li",
    optionItemAlt: ".answerList li",
    fillInput: 'input[type="text"], input[type="number"], input[type="tel"]',
    essayTextarea: "textarea",
    submitButton: ".btnSub, .submitBtn",
    successMark: ".fl.endTip",
    successText: "提交成功",
  },
};