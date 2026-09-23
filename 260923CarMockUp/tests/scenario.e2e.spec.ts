import { test, expect } from "@playwright/test";

test("departure, congestion, rerouting and arrival persist a single coherent journey", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".recommendation-time strong")).toHaveText("18:00");
  await expect(page.locator(".route-stats")).toContainText("18:23");
  await page.getByRole("button", { name: "03 돌발 정체" }).click();
  await expect(page.locator(".recommendation-time strong")).toHaveText("18:35");
  await expect(page.locator(".arrival-margin")).toContainText("−5");
  const atJunction = await page.locator(".day-weather b").innerText();
  await page.getByRole("button", { name: "우회 경로로 변경" }).click();
  await expect(page.locator(".recommendation-time strong")).toHaveText("18:26");
  await expect(page.locator(".day-weather b")).toHaveText(atJunction);
  await expect(page.locator(".arrival-margin")).toContainText("+4");
  await page.getByRole("button", { name: "도착 장면으로 이동" }).click();
  await expect(page.locator(".vehicle-mini-stat strong")).toContainText(
    "9,843.8",
  );
  await page.getByRole("button", { name: "이번 주행 기록 보기" }).click();
  await expect(page.locator(".trip-row")).toHaveCount(6);
  await expect(page.locator(".trip-row").first()).toContainText("3.8");
  await expect(page.locator(".trip-row").first()).toContainText("18분");
  await page.reload();
  await page.getByRole("button", { name: "주행 기록", exact: true }).click();
  await expect(page.locator(".trip-row")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("automatic demo supports pause and completes once at 2x", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "시연 배속 변경" }).click();
  await page.getByRole("button", { name: "전체 시연", exact: true }).click();
  await page.waitForTimeout(2600);
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  const time = await page.locator(".day-weather b").innerText();
  await page.waitForTimeout(600);
  await expect(page.locator(".day-weather b")).toHaveText(time);
  await page.getByRole("button", { name: "이어서 재생", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "이번 주행 기록 보기" }),
  ).toBeVisible({ timeout: 24000 });
  const state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("drivemate-demo-v1")!),
  );
  expect(state.trips).toHaveLength(6);
  expect(state.mileage).toBe(9843.8);
  expect(state.parking).toBe("office");
});

test("phone layout and native back behavior stay usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "캘린더", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "일정 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() =>
    (window as Window & { driveMateBack: () => boolean }).driveMateBack(),
  );
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".calendar-page")).toBeVisible();
  await page.evaluate(() =>
    (window as Window & { driveMateBack: () => boolean }).driveMateBack(),
  );
  await expect(page.locator(".map-section")).toBeVisible();
});

test("damaged persistent data cannot break the trip history screen", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "drivemate-demo-v1",
      JSON.stringify({
        events: [],
        mileage: 10,
        parking: null,
        trips: [
          {
            id: "broken",
            destination: "office",
            baseline: 10,
            actual: 12,
            distance: 1,
          },
        ],
      }),
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "주행 기록", exact: true }).click();
  await expect(page.locator(".trip-row")).toHaveCount(5);
});

test("an empty calendar offers travel estimates without inventing an appointment", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem("drivemate-demo-v1")!);
    data.events = [];
    localStorage.setItem("drivemate-demo-v1", JSON.stringify(data));
  });
  await page.reload();
  await expect(page.locator(".recommendation-time")).toContainText("예상 주행");
  await expect(page.locator(".recommendation-time")).not.toContainText(
    "권장 출발",
  );
  await expect(page.locator(".arrival-margin")).toContainText("주차 · 도보");
  await page.getByRole("button", { name: "어떻게 계산해?" }).click();
  await expect(page.locator(".quick-answer")).toContainText(
    "연결된 일정이 없어",
  );
  await expect(page.locator(".quick-answer")).not.toContainText("18:30");
});
