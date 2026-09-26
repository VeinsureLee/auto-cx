import { lessonNeedsWork } from "./study-memo.mjs";
import { isLockedLesson } from "./task-manifest.mjs";

function parseSectionNumber(text) {
  const match = String(text ?? "").trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 1000 + (match[2] ? Number(match[2]) : 0);
}

function lessonSectionKey(lesson) {
  if (lesson.section) {
    return parseSectionNumber(lesson.section);
  }
  const prefix = String(lesson.title ?? "").match(/^(\d+(?:\.\d+)?)/);
  return prefix ? parseSectionNumber(prefix[1]) : null;
}

function lessonIdentity(lesson) {
  return lesson.knowledgeId ?? `${lesson.ordinal}`;
}

export function filterLessonsByQuery(lessons, queries) {
  if (!queries?.length) {
    return lessons;
  }
  const matched = new Set();
  const parts = queries.flatMap((query) =>
    String(query ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  );

  for (const part of parts) {
    const range = part.match(/^(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)$/);
    if (range) {
      const start = parseSectionNumber(range[1]);
      const end = parseSectionNumber(range[2]);
      if (start === null || end === null) {
        continue;
      }
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (const lesson of lessons) {
        const key = lessonSectionKey(lesson);
        if (key !== null && key >= low && key <= high) {
          matched.add(lessonIdentity(lesson));
        }
      }
      continue;
    }

    const isChapter = /^\d+$/.test(part);
    const target = parseSectionNumber(part);
    if (target === null) {
      continue;
    }
    for (const lesson of lessons) {
      const key = lessonSectionKey(lesson);
      if (key === null) {
        continue;
      }
      if (isChapter) {
        if (Math.floor(key / 1000) === Math.floor(target / 1000)) {
          matched.add(lessonIdentity(lesson));
        }
      } else if (key === target) {
        matched.add(lessonIdentity(lesson));
      }
    }
  }

  return lessons.filter((lesson) => matched.has(lessonIdentity(lesson)));
}

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
      if (lesson.completed || isLockedLesson(lesson)) return false;
      const memoLesson = memoLessons.find((candidate) => String(candidate.knowledgeId) === id);
      return Boolean(memoLesson && lessonNeedsWork(memoLesson, {
        phase,
        submitDryRun: !dryRun,
      }).any);
    })
    .slice(0, limit);
}

export async function runDynamicWorkerPool({ concurrency, loadCandidates, runItem, keyOf, onSettled }) {
  const settled = [];
  const active = new Map();
  const activeIds = new Set();
  const attemptedIds = new Set();
  let catalogFailed = false;
  let catalogError = null;
  let settlementFailed = false;
  let settlementError = null;

  async function takeCandidate() {
    if (catalogFailed) {
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
    settled.push(settledEntry);
    if (onSettled) {
      try {
        await onSettled(settledEntry);
      } catch (error) {
        if (!settlementFailed) {
          settlementFailed = true;
          settlementError = error;
        }
      }
    }

    await startWorker(winner.slot);
  }

  if (catalogFailed) {
    throw catalogError;
  }
  if (settlementFailed) {
    throw settlementError;
  }
  return settled;
}
