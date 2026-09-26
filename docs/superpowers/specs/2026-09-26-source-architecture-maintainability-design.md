# Source Architecture Refactor — Design

Date: 2026-09-26
Status: approved in chat for spec review; implementation not started

## Goal and constraints

Organize the complete `src/` tree by responsibility to make maintenance and diagnosis easier. This is a **behavior-preserving refactor**. Do not alter commands, flags, console output, selectors, completion rules, task order, concurrency, retries, browser interactions, LLM requests, stored data, or privacy behavior. In particular, preserve the assessment-before-video gate, `--dry-run`/`--phase` exceptions, memo/report schema and default file paths, and the existing exported APIs and paths imported by tests. Do not silently fix known functional issues as part of the refactor.

No real-platform login, study, submission, or playback commands are run as part of this work. Automated tests must use offline fixtures/fakes.

## Current shape and maintenance pressure

The project currently has flat `src/*.mjs` modules. `study.mjs` (~944 lines) combines course selection, browser lifecycle, lesson scheduling, assessment and video task execution, progress, persistence, and report construction. `quiz.mjs` (~636 lines) combines DOM extraction, fill/submit state transitions, and in-video popup handling. Some imports mix responsibilities (`study-scheduler` imports memo status helpers; `task-manifest` imports progress helpers). Browser `evaluateAll` callbacks run in an isolated execution context, not the Node.js module context; a recent runtime error illustrates why this boundary needs explicit tests. Tests and npm scripts import existing top-level file paths directly.

## Proposed organization

Keep existing command entrypoints (`login.mjs`, `progress-cli.mjs`, `study-cli.mjs`) at their current paths. Retain every existing top-level import path and named export, using thin re-export compatibility modules for moved logic. Command modules remain executable at their current paths and must keep exactly the same CLI contract. Internal code should import canonical modules rather than routing through compatibility shims; shims must not acquire new business logic.

- `src/platform/`: Chaoxing selectors, course/lesson navigation and catalog discovery, task surface/tab identity, task-point DOM state. Any `evaluateAll` or `evaluate` browser callback remains self-contained, receives selectors/data explicitly, and is tested as a serialized callback without access to module-scope helpers.
- `src/assessment/`: chapter question extraction, filling/submission/result detection, video popup handling, and LLM prompt/request/response parsing. The LLM boundary accepts question data and returns answers; no new external provider is added.
- `src/video/`: media observation, natural-playback completion, video task runner. Existing task-point status reading stays in the platform layer; video consumes its result.
- `src/learning/`: lesson workflow (homework gate then ordered videos), per-task progress/resume, scheduler/worker coordination, and terminal progress display. Scheduling remains lesson-scoped and bounded as before.
- `src/persistence/`: memo schema and mutations, JSON/Markdown storage, report assembly/writing. Separate pure status/memo decisions from filesystem effects if needed to avoid reverse dependencies, while keeping the serialized shape unchanged.

A small shared utility may be extracted only when used across boundaries and it does not introduce a cross-layer dependency. Avoid adding a generic framework, service container, or broad abstraction hierarchy. Component APIs should pass the minimum existing inputs and return the existing result/status shapes; do not introduce format migrations.

### Dependency direction

CLI → learning orchestration → platform / assessment / video / persistence. Assessment and video may use platform page adapters; platform must not depend on learning, assessment, video, or persistence. Persistence can use pure data helpers but must not reach into Playwright. Existing top-level compatibility exports point inward to canonical implementations; canonical implementations do not import compatibility exports. Preserve independent progress-report CLI functionality.

### Runtime data flow and failure semantics

At runtime the CLI loads config, session and selected courses; learning obtains the course catalog, selects one eligible lesson per worker, discovers its tasks, completes homework first except for explicit video-only phase, then plays each video sequentially. The workflow records per-task completion in the memo and constructs the same report after execution. The rearrangement must preserve browser ownership and closure, signal handling, progress output, failure statuses, retry limits, memo write order and uncertainty handling. All task failures must retain their existing propagated or recorded shapes. No new network destination, log of credentials, or persistent field is introduced.

## Incremental migration

1. Establish baseline tests for public exports and representative offline contracts: CLI argument/format behavior, report/memo JSON structures, lesson phase/order and resume behavior, and serialized browser callback isolation. Record the baseline suite result; tests are not allowed to call the live site.
2. Migrate platform and pure DOM-facing modules, maintaining top-level shims and adjusting internal imports. Verify after the batch.
3. Migrate assessment and video modules, splitting `quiz.mjs` by chapter versus popup responsibilities without changing selectors/interaction timing. Verify after the batch.
4. Migrate persistence and learning orchestration, separating browser/worker ownership from per-lesson work and pure report construction; do not change callback sequencing. Verify after each small batch.
5. Update `npm run check` to include all canonical `.mjs` files, add a short maintainer architecture map to README or a developer note, and check for import cycles or dead compatibility shims. Keep compatibility shims where they protect existing paths.

If a move exposes a behavioral dependency that cannot be kept without changing behavior, stop and ask rather than folding a functional change into this refactor.

## Verification and acceptance

Run `npm test`, `npm run check`, and `git diff --check` after each meaningful batch and at the end. Check export parity for the pre-existing public modules; fixture tests must exercise browser evaluation in a context where outer Node bindings are unavailable. Confirm unchanged npm entrypoints, console messages, report/memo field names and statuses, and documented file paths. No live-platform verification is claimed; code-only verification cannot prove behavior against changing site DOM.

This refactor is accepted when responsibilities have clear domain homes, internal dependencies follow the proposed direction, old paths remain compatible, all offline checks pass, and no intentional runtime/data-format change is present.
