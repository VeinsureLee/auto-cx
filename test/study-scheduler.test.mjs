import assert from "node:assert/strict";
import test from "node:test";

import {
  runDynamicWorkerPool,
  selectEligibleLessons,
} from "../src/study-scheduler.mjs";

function catalog(id, { locked = false, completed = false } = {}) {
  return {
    knowledgeId: id,
    section: id,
    title: `${id} 标题`,
    completed,
    progressText: locked ? "需完成之前闯关任务点，该章节才能解锁" : "1个待完成任务点",
  };
}

function memo(id, { video = "pending", homework = "pending" } = {}) {
  return {
    knowledgeId: id,
    section: id,
    video: { status: video },
    homework: { status: homework },
  };
}

test("selectEligibleLessons excludes locked, active, attempted, and completed lessons", () => {
  const selected = selectEligibleLessons({
    catalogLessons: [catalog("1.1"), catalog("1.2", { locked: true }), catalog("1.3"), catalog("1.4")],
    memoLessons: [memo("1.1"), memo("1.2"), memo("1.3"), memo("1.4", { video: "done", homework: "submitted" })],
    queries: ["1"],
    activeIds: new Set(["1.1"]),
    attemptedIds: new Set(["1.3"]),
    phase: null,
    dryRun: false,
    limit: 3,
  });
  assert.deepEqual(selected, []);
});

test("runDynamicWorkerPool never exceeds concurrency and refills released slots", async () => {
  const items = ["a", "b", "c", "d"];
  let running = 0;
  let peak = 0;
  const completed = [];

  await runDynamicWorkerPool({
    concurrency: 3,
    keyOf: (item) => item,
    loadCandidates: ({ activeIds, attemptedIds }) =>
      items.filter((item) => !activeIds.has(item) && !attemptedIds.has(item)),
    runItem: async (item, slot) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, item === "a" ? 20 : 5));
      running -= 1;
      return { item, slot };
    },
    onSettled: ({ item }) => completed.push(item),
  });

  assert.equal(peak, 3);
  assert.deepEqual(new Set(completed), new Set(items));
});

test("runDynamicWorkerPool discovers an item unlocked by a completed predecessor", async () => {
  let unlocked = false;
  const started = [];
  await runDynamicWorkerPool({
    concurrency: 3,
    keyOf: (item) => item,
    loadCandidates: ({ activeIds, attemptedIds }) =>
      ["first", ...(unlocked ? ["second"] : [])]
        .filter((item) => !activeIds.has(item) && !attemptedIds.has(item)),
    runItem: async (item) => {
      started.push(item);
      if (item === "first") unlocked = true;
    },
  });
  assert.deepEqual(started, ["first", "second"]);
});

test("runDynamicWorkerPool isolates item failures and continues remaining work", async () => {
  const settled = [];
  await runDynamicWorkerPool({
    concurrency: 2,
    keyOf: (item) => item,
    loadCandidates: ({ activeIds, attemptedIds }) =>
      ["bad", "good"].filter((item) => !activeIds.has(item) && !attemptedIds.has(item)),
    runItem: async (item) => {
      if (item === "bad") throw new Error("lesson failed");
      return "done";
    },
    onSettled: (result) => settled.push(result),
  });
  assert.equal(settled.length, 2);
  assert.equal(settled.find((entry) => entry.item === "bad").status, "rejected");
  assert.equal(settled.find((entry) => entry.item === "good").status, "fulfilled");
});

test("runDynamicWorkerPool does not double-dispatch an already active candidate", async () => {
  const started = [];
  await runDynamicWorkerPool({
    concurrency: 2,
    keyOf: (item) => item.id,
    loadCandidates: () => [{ id: "x" }, { id: "x" }],
    runItem: async (item) => {
      started.push(item.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  });
  assert.deepEqual(started, ["x"]);
});

test("runDynamicWorkerPool settles active workers before rethrowing a loadCandidates error", async () => {
  let calls = 0;
  const settled = [];
  await assert.rejects(
    runDynamicWorkerPool({
      concurrency: 2,
      keyOf: (item) => item,
      loadCandidates: () => {
        calls += 1;
        if (calls >= 3) throw new Error("catalog failed");
        return ["a", "b"];
      },
      runItem: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return item;
      },
      onSettled: (entry) => settled.push(entry.item),
    }),
    /catalog failed/,
  );
  assert.deepEqual(settled.sort(), ["a", "b"]);
});

async function settleOutcome(promise) {
  try {
    const value = await promise;
    return { rejected: false, value };
  } catch (error) {
    return { rejected: true, error };
  }
}

test("runDynamicWorkerPool rethrows a falsy loadCandidates error", async () => {
  for (const thrown of [undefined, null, 0, "", false]) {
    const outcome = await settleOutcome(
      runDynamicWorkerPool({
        concurrency: 1,
        keyOf: (item) => item,
        loadCandidates: () => {
          throw thrown;
        },
        runItem: async () => {},
      }),
    );
    assert.equal(outcome.rejected, true, `should reject when loadCandidates throws ${String(thrown)}`);
    assert.equal(outcome.error, thrown);
  }
});

test("runDynamicWorkerPool keeps settling active workers when onSettled throws", async () => {
  const completed = [];
  const reported = [];
  await assert.rejects(
    runDynamicWorkerPool({
      concurrency: 2,
      keyOf: (item) => item,
      loadCandidates: ({ activeIds, attemptedIds }) =>
        ["a", "b"].filter((item) => !activeIds.has(item) && !attemptedIds.has(item)),
      runItem: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item === "a" ? 5 : 15));
        completed.push(item);
        return item;
      },
      onSettled: (entry) => {
        reported.push(entry.item);
        throw new Error("onSettled failed");
      },
    }),
    /onSettled failed/,
  );
  assert.deepEqual(completed.sort(), ["a", "b"]);
  assert.deepEqual(reported.sort(), ["a", "b"]);
});

test("runDynamicWorkerPool rethrows a catalog error even when onSettled later throws", async () => {
  let calls = 0;
  let settlements = 0;
  await assert.rejects(
    runDynamicWorkerPool({
      concurrency: 2,
      keyOf: (item) => item,
      loadCandidates: () => {
        calls += 1;
        if (calls >= 3) throw new Error("catalog failed");
        return ["a", "b"];
      },
      runItem: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item === "a" ? 5 : 15));
        return item;
      },
      onSettled: () => {
        settlements += 1;
        if (settlements >= 2) throw new Error("onSettled failed");
      },
    }),
    /catalog failed/,
  );
  assert.equal(settlements, 2);
});
