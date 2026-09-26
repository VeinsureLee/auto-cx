# Final fix report

## Status

Implemented both Critical fixes in the concurrent-lesson-playback worktree. No live site or subagents were used.

## Changes

- `src/task-point-status.mjs`
  - Removed generic `完成` matching.
  - Condition text such as `完成条件：观看时长需 ≥ 总时长的 90%` now remains `unavailable` unless explicit task-point completion semantics, a completion class, or an explicit boolean says completed.
  - Preserved pending precedence and contradictory `completed: false` behavior.
- `src/study-memo.mjs` / `src/study.mjs`
  - Added schema-compatible optional `completedTaskKeys` arrays to video and homework progress.
  - Successful individual tasks persist their keys uniquely while the aggregate remains pending.
  - Resume skips completed keys in manifest order and only writes video `done`, formal homework `submitted`, or dry-run homework `dry_run` after all category tasks succeed.
  - Passed task keys through task runners and retained existing phase, dry-run, answer, and trial behavior.
- Tests cover condition candidates and resumed multi-video/multi-homework progress.

## Verification

- Focused tests: passed (45 tests).
- Full `npm test`: passed, **148/148**.
- `npm run check`: passed.
- `git diff --check`: passed.

## Commit

`3da6604 fix: resume per-task lesson progress`

## Concerns

No live platform verification was performed, as required. Existing platform selector/synchronization behavior remains dependent on the live site DOM.
