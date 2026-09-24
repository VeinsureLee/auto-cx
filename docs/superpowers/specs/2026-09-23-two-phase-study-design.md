# 超星两阶段学习执行器设计

**日期：** 2026-09-23  
**状态：** 已实现，待真实课程小范围验证

## 背景

现有自动学习流程按当前可见任务点即时处理：播放媒体、回答测验并前进。这会导致视频、视频弹题、章节作业与导航逻辑相互耦合；中断后没有可靠断点，已播放视频可能重复，未完成视频也无法稳定恢复。

目标是把执行重构为两个显式阶段：

1. 在所选课程范围内，按课程/课节/任务点顺序连续自然播放所有视频，达到各视频时长的 **95%** 后转到下一视频。
2. 只有全部已发现视频达到 95% 后，统一处理章节作业；播放期间遇到会阻塞播放的视频弹题时，仅即时作答以解锁播放。

不使用 seek、拖动进度、伪造焦点或绕过验证码。未达到 95% 的视频在恢复时从头自然播放。

## 已确认的产品决策

- 阶段范围：`--course` 选择范围内的所有课程共享一个全局视频屏障；全部视频达到 95% 后才进入统一作业阶段。
- 视频弹题：若弹题阻塞播放，立即通过 AI 作答、提交并点击“继续”；不把章节作业提前到视频阶段。
- 断点恢复：未达到 95% 的视频下次从头自然播放，不修改 `video.currentTime`。
- 重试：同一视频单次运行最多尝试 3 次；仍失败则持久化为 `failed`，后续视频继续处理，本轮不进入作业阶段；下一次运行从头重试。
- 阶段切换：存在 `pending`、`playing`、`blocked` 或 `failed` 视频时保持视频阶段，绝不提前处理作业。
- `--dry-run`：视频真实播放并记录断点；章节作业填答但不提交；视频弹题为解除播放阻塞仍会实际提交。

## 架构

```text
study-cli
  └─ study coordinator
      ├─ state store
      ├─ manifest discovery
      ├─ video runner
      │   └─ blocking video-popup quiz adapter
      ├─ global video barrier
      └─ assessment runner
          └─ chapter-homework quiz adapter
```

### `study-cli.mjs`

保留 `--course`、`--dry-run`。新增 `--phase video`，只执行或恢复视频阶段，供真实验证连续播放与断点恢复。默认 `study` 从持久状态自动恢复当前阶段并在屏障满足时继续作业阶段。

CLI 在执行前读取状态文件；执行中不依赖最终报告作为恢复来源。执行结束或异常时生成派生的 JSON/Markdown 报告。

### `study.mjs`

缩减为协调器：

1. 加载配置、认证会话、课程列表和持久状态；
2. 发现或补全任务清单；
3. 若当前阶段为 `video`，调用视频执行器；
4. 验证全局视频屏障；
5. 屏障满足且未指定 `--phase video` 时，调用作业执行器；
6. 写最终报告。

它不再直接以“当前可见 iframe”作为任务身份，也不再把页面导航成功视为课节完成。

### `study-state.mjs`

新建版本化、可恢复状态存储。默认文件：

- `artifacts/video-playback-state.json`
- `artifacts/video-playback-state.md`

状态文件包含：

```json
{
  "schemaVersion": 1,
  "phase": "video",
  "createdAt": "2026-09-23T00:00:00.000Z",
  "updatedAt": "2026-09-23T00:00:00.000Z",
  "selection": { "courseQueries": ["科研诚信"] },
  "courses": [
    {
      "courseId": "266616255",
      "clazzId": "154973704",
      "name": "课程名称",
      "lessons": [
        {
          "knowledgeId": "1235078466",
          "title": "2.2",
          "tasks": [
            {
              "key": "266616255:154973704:1235078466:1236261385",
              "kind": "video",
              "tabId": "dct1",
              "cardId": "1236261385",
              "ordinal": 1,
              "title": "视频",
              "video": {
                "status": "pending",
                "durationSeconds": null,
                "targetSeconds": null,
                "maxObservedSeconds": 0,
                "attempts": 0,
                "lastError": null,
                "updatedAt": null
              },
              "assessment": { "status": "pending" },
              "videoPopupQuizzes": []
            }
          ]
        }
      ]
    }
  ]
}
```

视频状态：`pending`、`playing`、`reached_95`、`blocked`、`failed`。作业状态：`pending`、`filling`、`submit_started`、`submitted`、`uncertain`、`dry_run`、`failed`。

状态写入通过临时文件 + rename 原子替换。以下事件必须落盘：清单发现、开始尝试、进度采样（固定时间间隔或显著进度增量）、达到 95%、视频弹题结果、失败/重试、作业提交意图、作业最终状态与阶段切换。

### `task-manifest.mjs`

新建任务发现和定位适配器。

- 在课程 cards iframe 内枚举 `li[id^="dct"]`。
- 保存 `tabId`、`cardId`、`title`、DOM 顺序；任务稳定键优先使用 `courseId + clazzId + knowledgeId + cardId`，没有 `cardId` 时以 tab ID 和顺序为回退。
- 按标签元数据和真正加载出的可见模块帧分类：视频、作业、文档、其他。
- 对作业，标题 `作业` 或可见 `.RightCon.newTestCon/#form1` 都可识别。
- 重新执行时优先通过 `cardId` 定位 tab，再以 `tabId + ordinal` 回退；所有 tab 搜索均限定到 cards iframe，不再使用顶层 `page.locator()`。

发现是可增量的。因闯关锁定而不可访问的后续任务记录为 `blocked`；它们不会被伪装为完成。

### `video-runner.mjs`

新建单线程视频执行器。对每个 `video.status !== reached_95` 的任务：

1. 重新打开对应课程、课节与目标 tab；
2. 找到可见 `/ananas/modules/video/index.html` iframe 和 `<video>`；
3. 获取有效 `duration`，计算 `targetSeconds = duration × 0.95`；
4. 从零开始使用实际播放控件自然播放；
5. 周期采样 `currentTime`、`duration`、`paused`、`readyState` 并写断点；
6. `currentTime >= targetSeconds` 时先持久化 `reached_95`，随后通过 cards iframe 的下一个清单项跳转；
7. 出现阻塞视频弹题时调用视频弹题适配器，记录答案/正确性后点击继续，再等待视频进度；
8. 对无元数据、长时间无进度、播放器脱离、tab 缺失和导航异常按三次上限处理。

视频达到 95% 是本地持久化判定，不假设平台课节图标会同步为完成。重新运行仅跳过 `reached_95` 视频，其他状态从头播放。

### `assessment-runner.mjs`

仅在全局视频屏障满足后运行。逐条处理任务清单中的作业：

1. 重新打开对应课程/课节；
2. 通过已保存 `cardId` 定位“作业”标签并点击；
3. 等待真实内联作业 DOM：`.RightCon.newTestCon` / `#form1`；
4. 复用 `quiz.mjs`：`.TiMu.newTiMu[data]`（0 单选、1 多选、2 填空、3 判断、4 简答）、`ul.Zy_ulTop li[qid]` 选项、`.btnSubmit`、`#confirmSubWin a.bluebtn`；
5. 非 dry-run 下先写 `submit_started`，点击提交与确认；根据页面“待完成/已完成”状态及成功标识写 `submitted` 或 `uncertain`。

若进程在提交点击后中断，下一次先重新打开作业并读取平台状态；只有确认仍未完成才再次提交，避免盲目重复提交。验证码只记录 `failed` 并要求人工处理。

### `quiz.mjs` 与 `task-point.mjs`

- `quiz.mjs` 保留两个明确适配器：视频弹题和章节作业；不将二者选择器混用。
- `task-point.mjs` 收敛为 frame、媒体状态、播放/进度检测与 tab 导航的低层工具。
- 已提供的选择器将集中在 `study-selectors.mjs`，新增 cards iframe 内 tab、视频弹题和作业的显式选择器。

## 全局视频屏障

只要清单中存在任意 `pending`、`playing`、`blocked` 或 `failed` 视频，状态保持 `phase: "video"`。作业阶段仅在全部视频为 `reached_95` 或任务明确为非视频时开始。

如果平台需要先完成作业才解锁后续视频，执行器会停在视频阶段并报告具体阻塞项；不会为了跨越门槛而提前答作业或假装视频完成。

## 错误策略

| 情况 | 持久状态 | 当前运行行为 | 下次运行 |
|---|---|---|---|
| 浏览器/进程中断 | `playing` + 最后观测位置 | 运行终止 | 从头重播该视频 |
| 未加载元数据 | `failed` + 原因 | 当前视频最多三次 | 从头重播 |
| 连续无进度或平台暂停 | `failed`/`blocked` + 原因 | 最多三次，之后继续扫描后续视频 | 从头重播 |
| 阻塞视频弹题 | 记录弹题结果 | 即时作答并继续 | 继续视频任务 |
| 视频弹题无法作答 | `blocked` + 原因 | 不伪造进度 | 重新尝试或人工处理 |
| 章节作业验证码 | `failed` + 原因 | 停止该作业 | 人工完成后重新检查 |
| 提交结果不确定 | `uncertain` | 不盲目重提 | 先从平台状态对账 |

## 配置与报告

新增配置：

- `CHAOXING_VIDEO_STATE_PATH=artifacts/video-playback-state.json`
- `CHAOXING_VIDEO_STATE_MARKDOWN_PATH=artifacts/video-playback-state.md`
- `CHAOXING_VIDEO_TARGET_PERCENT=95`
- `CHAOXING_VIDEO_RETRY_LIMIT=3`

新报告应显示：课程、课节、任务、视频时长、95% 目标、最大观测位置、状态、重试次数、视频弹题结果、作业状态和最后错误。

## 验证策略

1. **状态单测**：状态迁移、原子写入、恢复跳过、95% 临界、三次重试与全局屏障。
2. **清单单测**：`dct*` / `cardId` 身份、同标题任务、重复运行定位与 iframe 范围。
3. **媒体单测**：中断后从头重播、95% 即转换、缺失元数据、停滞、视频弹题处理后继续播放。
4. **作业单测**：题型映射、选项索引、提交意图、平台已完成对账与验证码阻断。
5. **真实验证**：先可见浏览器运行 `npm run study -- --phase video --course <课程>`；检查状态表、播放次序和重启恢复；再运行 `npm run study:dry -- --course <课程>`；最终才执行真实作业提交。

## 非目标

- 不调用 `video.currentTime`、不拖动进度。
- 不绕过验证码、离页暂停、平台锁定或题目字体混淆。
- 不把本地达到 95% 伪装成平台已完成。
- 不并发播放多个视频。
