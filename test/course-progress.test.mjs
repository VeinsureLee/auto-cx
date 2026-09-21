import assert from "node:assert/strict";
import test from "node:test";

import { mapWithConcurrency, summarizeLessons } from "../src/course-progress.mjs";

test("summarizeLessons separates completed and incomplete lessons", () => {
  assert.deepEqual(
    summarizeLessons([
      { status: "completed" },
      { status: "not_completed" },
      { status: "not_completed" },
    ]),
    { completed: 1, completionPercent: 33.33, notCompleted: 2, total: 3 },
  );
});

test("mapWithConcurrency respects the configured worker limit and result order", async () => {
  let activeWorkers = 0;
  let maximumWorkers = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    activeWorkers += 1;
    maximumWorkers = Math.max(maximumWorkers, activeWorkers);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeWorkers -= 1;
    return value * 2;
  });

  assert.equal(maximumWorkers, 2);
  assert.deepEqual(results, [2, 4, 6, 8]);
});
