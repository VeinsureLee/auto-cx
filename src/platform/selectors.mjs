// 自动学习相关选择器的集中地。
// 首次真实运行发现 DOM 与预期不符时，只需调整本文件中的选择器。

export const STUDY_SELECTORS = {
  // 课程目录
  chapterNav: 'a[data-url*="/mycourse/studentcourse"]',
  lessonItem: ".chapter_item:has(.catalog_name.newCatalog_name a.clicktitle)",
  lessonLink: ".catalog_name.newCatalog_name a.clicktitle",

  // 课节内容与任务标签。任务发现、恢复定位均限定在 cards iframe 内。
  cardsFramePath: "/mooc-ans/knowledge/cards",
  taskTab: 'li[id^="dct"]',

  // 任务点模块帧路径识别（URL pathname 包含即视为该类型）
  moduleFrames: [
    { type: "video", path: "/ananas/modules/video/index.html" },
    { type: "audio", path: "/ananas/modules/audio/index.html" },
    { type: "quiz", path: "/mooc-ans/work/doHomeWorkNew" },
    { type: "quiz", path: "/ananas/modules/work/index.html" },
    { type: "doc", path: "/ananas/modules/document/" },
    { type: "other", path: "/ananas/modules/insertimage/" },
  ],

  // 内联章节测验（作业）容器（出现在课程主帧，切换任务点标签时可见/隐藏）
  inlineQuiz: ".RightCon.newTestCon, #form1:has(.TiMu.newTiMu)",

  // 视频播放中弹出的内嵌测验（video quiz）
  videoQuiz: {
    overlay: ".tkTopic_con",
    item: ".tkTopic_con .tkItem",
    itemTitle: ".tkItem_title",
    optionItem: ".tkItem_ul li.ans-videoquiz-opt",
    optionInput: 'input[type="radio"]',
    submitButton: "#videoquiz-submit",
    continueButton: "#videoquiz-continue",
    correctMark: "#spanHas",
    wrongMark: "#spanNot",
    wrongBackMark: "#spanNotBack",
    resultMarks: ["#spanHas", "#spanNotBack", "#spanNot"],
  },

  // 任务点完成状态（只读取任务标签或其关联 DOM，不点击、不改播放进度）。
  // 图标与提示均位于 cards 帧的任务标签内部；真实 DOM 校准只改这里。
  taskPoint: {
    iconCandidates: [
      "span.ans-job-icon",
      ".ans-job-icon",
      ".jobIcon",
      "[class*='job-icon']",
    ],
    conditionTextCandidates: [
      ".jobUnfinish",
      ".jobFinish",
      "[class*='jobUnfinish']",
      "[class*='jobTip']",
    ],
    // class 分词后表示“已完成”的关键字（按分词边界匹配，避免误伤 notdone 等）
    completionClassWords: ["done", "complete", "finished", "clear"],
    // 可能携带显式完成布尔值的属性名
    completionAttrNames: ["data-completed", "data-finish", "data-finished", "data-complete"],
  },

  // 章节测验（作业）页面（基于真实 DOM：.RightCon.newTestCon）
  quiz: {
    questionBlock: ".TiMu.newTiMu",
    qTypeAttr: "data", // 0=单选 1=多选 2=填空 3=判断 4=简答
    stem: ".Zy_TItle",
    stemContent: ".qtContent",
    stemLabel: ".newZy_TItle",
    stemText: "p",
    optionItem: "ul.Zy_ulTop li",
    optionMark: ".num_option, i.fl",
    optionDataAttr: "data",
    fillInput: 'input[type="text"], input[type="number"], input[type="tel"]',
    essayTextarea: "textarea",
    submitButton: ".btnSubmit, .btnSub, .submitBtn",
    // 提交按钮旁边的「暂时保存」：演练模式只填不交，用它把答案暂存在平台上。
    saveButton: [
      "#tempsave",
      ".tempsave",
      ".btnSave",
      ".saveBtn",
      'input[value*="保存"]',
      'a:has-text("暂时保存")',
      'span:has-text("暂时保存")',
      'a:has-text("保存草稿")',
    ].join(", "),
    confirmButton: "#confirmSubWin a.bluebtn, #confirmSubWin .bluebtn, #popok",
    captchaWindow: "#verifyCodeWin",
    captchaInput: "#inputCode",
    successMark: ".fl.endTip",
    successText: "提交成功",
    completedMark: ".fl.endTip, .mark_answer, .viewAnswer, .scoreDiv",
    completedText: /提交成功|已完成|查看答案|我的得分/,
    pendingText: /待完成|提交作业|提交答案/,
  },
};
