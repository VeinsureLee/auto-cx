const COURSE_LIST = "#courseList";
const COURSE_ITEM = `${COURSE_LIST} .course.learnCourse`;

async function findCourseFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if ((await frame.locator(COURSE_LIST).count()) > 0) {
        return frame;
      }
    }
    await page.waitForTimeout(250);
  }

  throw new Error("进入个人空间后未找到课程列表。");
}

async function waitForCourseListToSettle(frame, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  let previousSignature = null;
  let stableChecks = 0;

  while (Date.now() < deadline) {
    const signature = await frame.locator(COURSE_LIST).evaluate((courseList) => {
      const courses = courseList.querySelectorAll(".course.learnCourse");
      return `${courses.length}:${courseList.textContent?.length ?? 0}`;
    });

    if (signature === previousSignature) {
      stableChecks += 1;
      if (stableChecks >= 2) {
        return;
      }
    } else {
      previousSignature = signature;
      stableChecks = 0;
    }

    await frame.waitForTimeout(250);
  }
}

export function filterIncompleteCourses(courses) {
  return courses
    .filter((course) => !course.ended && !course.completed)
    .map(({ completed, ended, ...course }) => course);
}

export async function getIncompleteCourses(page, timeoutMs) {
  const frame = await findCourseFrame(page, timeoutMs);
  await frame.locator(COURSE_LIST).waitFor({ state: "attached", timeout: timeoutMs });
  await waitForCourseListToSettle(frame, timeoutMs);

  const courses = await frame.locator(COURSE_ITEM).evaluateAll((courseElements) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() || "";

    return courseElements.map((course) => {
      const inputValue = (selector) => course.querySelector(selector)?.value || "";
      const nameElement = course.querySelector(".course-name");
      const teacherElement = course.querySelector(".course-info p.line2.color3");
      const courseLink = course.querySelector(
        ".course-info h3 a[href], .course-cover > a[href]",
      );
      const progressText = normalize(course.querySelector(".btm-cover .l-txt")?.textContent);
      const percentText = normalize(course.querySelector(".bar-tip")?.textContent);
      const progressMatch = progressText.match(/(\d+)\s*\/\s*(\d+)/);
      const percentMatch = percentText.match(/(\d+(?:\.\d+)?)\s*%/);
      const scheduleText = Array.from(course.querySelectorAll(".course-info p"))
        .map((element) => normalize(element.textContent))
        .find((text) => /^开课时间\s*[：:]/.test(text));
      const scheduleMatch = scheduleText?.match(
        /^开课时间\s*[：:]\s*(.+?)\s*(?:～|~|至)\s*(.+)$/,
      );

      const completedTasks = progressMatch ? Number(progressMatch[1]) : null;
      const totalTasks = progressMatch ? Number(progressMatch[2]) : null;
      const percent = percentMatch ? Number(percentMatch[1]) : null;
      const ended =
        course.closest("#isState") !== null ||
        normalize(course.querySelector(".not-open-tip")?.textContent).includes("课程已结束");
      const completed =
        (totalTasks !== null && totalTasks > 0 && completedTasks >= totalTasks) ||
        (percent !== null && percent >= 100);

      return {
        clazzId: inputValue("input.clazzId"),
        completed,
        courseId: inputValue("input.courseId"),
        cpi: inputValue("input.curPersonId"),
        endDate: scheduleMatch?.[2]?.trim() || null,
        ended,
        name: normalize(nameElement?.getAttribute("title") || nameElement?.textContent),
        progress: {
          completed: completedTasks,
          percent,
          total: totalTasks,
        },
        role: inputValue('input[name="role"]'),
        startDate: scheduleMatch?.[1]?.trim() || null,
        teacher: normalize(teacherElement?.getAttribute("title") || teacherElement?.textContent),
        url: courseLink?.href || "",
      };
    });
  });

  return filterIncompleteCourses(courses);
}
