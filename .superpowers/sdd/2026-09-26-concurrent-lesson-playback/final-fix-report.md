# Final fix wave — concurrent lesson playback

## Scope and outcome

Implemented the requested final review fixes in this worktree only. No website actions were run, and no other agents/reviewers were dispatched.

- Browser disconnection or shared-context closure is now treated as a global fatal condition: the worker pool stops dispatching, drains already-active worker promises, avoids recording global failures as ordinary lesson failures, and propagates a fatal error for the existing failure-report path.
- SIGINT/SIGTERM now request orderly cancellation rather than re-sending the signal to the process. Progress stops/restores the terminal, the run closes Chromium to interrupt active Playwright work, the scheduler drains, and `runStudy` attaches a fatal report; the CLI's existing error handler writes the report and sets exit status 1.
- TTY dynamic rows are clamped to terminal width (with a one-column safety margin and approximate Unicode display widths) to avoid wrapping corrupting ANSI redraws.
- Explicit CLI concurrency is parsed before config resolution and supplied as an override, so malformed `CHAOXING_STUDY_CONCURRENCY` does not reject a valid CLI setting. Other environment configuration continues through normal validation, including on failure-report config loading.

## TDD evidence

Added regression tests before production changes in:

- `test/study-scheduler.test.mjs`: fatal worker failure stops further dispatch and drains active work; only successful in-flight work is settled.
- `test/study-progress.test.mjs`: SIGINT is an orderly cancellation (no process self-kill), terminal cursor restores once, and long TTY rows fit narrow columns.
- `test/config.test.mjs`: valid explicit concurrency overrides malformed study-concurrency env while unrelated malformed env remains rejected.

**RED command:**

```text
node --test test/study-scheduler.test.mjs test/study-progress.test.mjs test/config.test.mjs
```

**RED result before implementation:** 38 tests, 34 passed, 4 failed. The four expected failures were: config override still rejected malformed env; `requestStop` did not exist; narrow TTY rows exceeded the terminal width; and scheduler dispatched `must-not-start` after a fatal worker error. Exit code 1.

## Verification

**Focused GREEN command:**

```text
node --test test/study-scheduler.test.mjs test/study-progress.test.mjs test/config.test.mjs
```

Result: 38 passed, 0 failed.

**Full suite:**

```text
npm test
```

Result: 103 passed, 0 failed, 0 skipped.

**Syntax checks:**

```text
npm run check
```

Result: passed (all configured `node --check` files).

**Whitespace check:** `git diff --check` passed.

The full test suite and checks were rerun after the final changes. No real website actions were performed.

## Self-review and tradeoffs

- A browser/context fatal signal is observed through Playwright's `disconnected`/`close` events and current `isConnected`/`isClosed` state. Individual page failures remain ordinary lesson failures while the shared browser/context is healthy.
- Fatal shutdown allows already-started work to settle; successful work can still persist its normal outcome, while rejected work caused by a global failure is not emitted as a stream of lesson failures. On an OS signal, Chromium is closed immediately to make active work stop rather than waiting for playback to finish.
- The terminal width helper uses a lightweight built-in East Asian/emoji width approximation, not a third-party `wcwidth` library. This is dependency-free and adequate for the rendered labels, but terminal-specific glyph width behavior can vary.
- `readConfig` validates the explicit override through the same 1–3 range validator, while the CLI parser remains the source of command-line shape/duplicate validation.
- The report-on-error CLI path uses a valid concurrency override solely to read report paths, while still validating other environment settings; concurrency itself is irrelevant to writing the failure report.
- Automated tests exercise the scheduler, signal-state/progress contract, terminal clamp, and config precedence separately; no end-to-end Chromium/browser-disconnection test was run. The live platform test remains intentionally skipped as requested.

## Commit

`fix study shutdown and fatal browser failures` (the final commit ID is reported in the delivery response; a commit cannot embed its own hash without changing that hash).
