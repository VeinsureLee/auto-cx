import { lessonNeedsWork } from "../persistence/memo.mjs";
import { isLockedLesson } from "../platform/task-manifest.mjs";

import { filterLessonsByQuery } from "../shared/lesson-filter.mjs";
export { filterLessonsByQuery } from "../shared/lesson-filter.mjs";

export function selectEligibleLessons({
  catalogLessons,
  memoLessons,
  queries = null,
  activeIds = new Set(),
  attemptedIds = new Set(),
  phase = null,
  dryRun = false,
  limit = 1,
}) {
  return filterLessonsByQuery(catalogLessons, queries)
    .filter((lesson) => {
      const id = String(lesson.knowledgeId ?? "");
      if (!id || activeIds.has(id) || attemptedIds.has(id)) return false;
      if (isLockedLesson(lesson)) return false;
      // 该不该做统一由 lessonNeedsWork 决定（它内部已经排除「目录已完成」的课节），
      // 这里不再重复判断目录的 completed 标志，以免两处口径不一致。
      const memoLesson = memoLessons.find((candidate) => String(candidate.knowledgeId) === id);
      return Boolean(memoLesson && lessonNeedsWork(memoLesson, {
        phase,
        submitDryRun: !dryRun,
      }).any);
    })
    .slice(0, limit);
}

export async function runDynamicWorkerPool({
  concurrency,
  loadCandidates,
  runItem,
  keyOf,
  onSettled,
  isFatalError = () => false,
  shouldStop = () => false,
  getStopError = () => new Error("Worker pool stopped."),
}) {
  const settled = [];
  const active = new Map();
  const activeIds = new Set();
  const attemptedIds = new Set();
  let catalogFailed = false;
  let catalogError = null;
  let settlementFailed = false;
  let settlementError = null;
  let fatalFailed = false;
  let fatalError = null;

  function stopped() {
    if (fatalFailed) return true;
    if (!shouldStop()) return false;
    if (!fatalFailed) {
      fatalFailed = true;
      fatalError = getStopError();
    }
    return true;
  }

  async function takeCandidate() {
    if (catalogFailed || stopped()) {
      return null;
    }
    let candidates;
    try {
      candidates = await loadCandidates({
        activeIds: new Set(activeIds),
        attemptedIds: new Set(attemptedIds),
      });
    } catch (error) {
      catalogFailed = true;
      catalogError = error;
      return null;
    }
    if (stopped()) return null;
    const items = Array.isArray(candidates) ? candidates : [];
    return (
      items.find((item) => {
        const key = String(keyOf(item));
        return !activeIds.has(key) && !attemptedIds.has(key);
      }) ?? null
    );
  }

  async function startWorker(slot) {
    const item = await takeCandidate();
    if (item === null) {
      return false;
    }
    const key = String(keyOf(item));
    activeIds.add(key);
    const operation = Promise.resolve()
      .then(() => runItem(item, slot))
      .then(
        (value) => ({ status: "fulfilled", item, key, value }),
        (reason) => ({ status: "rejected", item, key, reason }),
      );
    active.set(slot, { item, key, operation });
    return true;
  }

  for (let slot = 1; slot <= concurrency; slot += 1) {
    await startWorker(slot);
  }

  while (active.size > 0) {
    const winner = await Promise.race(
      [...active.entries()].map(async ([slot, entry]) => ({
        slot,
        result: await entry.operation,
      })),
    );
    active.delete(winner.slot);
    activeIds.delete(winner.result.key);
    attemptedIds.add(winner.result.key);

    if (winner.result.status === "rejected" && isFatalError(winner.result.reason)) {
      if (!fatalFailed) {
        fatalFailed = true;
        fatalError = shouldStop() ? getStopError() : winner.result.reason;
      }
    }

    const settledEntry =
      winner.result.status === "fulfilled"
        ? {
            status: "fulfilled",
            item: winner.result.item,
            slot: winner.slot,
            value: winner.result.value,
          }
        : {
            status: "rejected",
            item: winner.result.item,
            slot: winner.slot,
            reason: winner.result.reason,
          };
    const reportable = !fatalFailed || winner.result.status === "fulfilled";
    if (reportable) settled.push(settledEntry);
    if (reportable && onSettled) {
      try {
        await onSettled(settledEntry);
      } catch (error) {
        if (!settlementFailed) {
          settlementFailed = true;
          settlementError = error;
        }
      }
    }

    if (!stopped()) await startWorker(winner.slot);
  }

  if (shouldStop() && !fatalFailed) {
    fatalFailed = true;
    fatalError = getStopError();
  }
  if (fatalFailed) {
    throw fatalError;
  }
  if (catalogFailed) {
    throw catalogError;
  }
  if (settlementFailed) {
    throw settlementError;
  }
  return settled;
}
