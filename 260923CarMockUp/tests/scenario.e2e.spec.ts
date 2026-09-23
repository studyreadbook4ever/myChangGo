import { test, expect, type Page } from "@playwright/test";

async function openWithControlledTime(page: Page) {
  await page.clock.install({ time: new Date("2026-09-23T09:00:00Z") });
  await page.goto("/");
  await page.clock.pauseAt(new Date("2026-09-23T09:00:10Z"));
}

async function nativeBack(page: Page) {
  return page.evaluate(() => {
    const handler = (window as Window & { driveMateBack?: () => boolean })
      .driveMateBack;
    if (!handler) throw new Error("Android back handler is not registered");
    return handler();
  });
}

async function storedState(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("drivemate-demo-v1")!),
  );
}

async function startNavigation(page: Page) {
  await page.getByRole("button", { name: "주행 시작", exact: true }).click();
  const navigation = page.getByRole("region", { name: "주행 내비게이션" });
  await expect(navigation).toBeVisible();
  return navigation;
}

async function reachCongestion(page: Page) {
  // runFor fires every interval callback; fastForward would fire each only once.
  await page.clock.runFor(8500);
  await expect(
    page.getByRole("button", { name: "우회 경로로 변경", exact: true }),
  ).toBeVisible();
}

test("starting a drive opens full-screen guidance and rerouting records one completed journey", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWithControlledTime(page);
  await expect(page.locator(".recommendation-time strong")).toHaveText("18:00");
  const navigation = await startNavigation(page);
  await expect(page.locator(".navigation-destination b")).toHaveText("18:15");
  await expect(page.locator(".navigation-schedule-line")).toContainText(
    "18:23",
  );
  await expect(
    page.getByRole("navigation", { name: "메인 메뉴" }),
  ).not.toBeVisible();
  await expect(page.locator(".topbar")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "전체 시연", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "시연 배속 변경" }),
  ).toHaveCount(0);
  await expect(page.locator(".scene-steps")).toHaveCount(0);
  const bounds = await navigation.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds!.width).toBeGreaterThanOrEqual(viewport.width - 2);
  expect(bounds!.height).toBeGreaterThanOrEqual(viewport.height - 2);
  await reachCongestion(page);
  await expect(
    page.getByRole("region", { name: "교통 상황과 우회 경로" }),
  ).toContainText("18:35");
  await page
    .getByRole("button", { name: "우회 경로로 변경", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "현재 경로 유지", exact: true }),
  ).not.toBeVisible();
  await expect(page.locator(".navigation-destination b")).toHaveText("18:18");
  await expect(page.locator(".navigation-schedule-line")).toContainText(
    "18:26",
  );
  await page.clock.runFor(22000);
  await expect(
    page.getByRole("button", { name: "주행 마치기", exact: true }),
  ).toBeVisible();
  const arrived = await storedState(page);
  expect(arrived.trips).toHaveLength(6);
  expect(arrived.mileage).toBe(9843.8);
  expect(arrived.parking).toBe("office");
  expect(arrived.trips[0]).toMatchObject({
    distance: 3.8,
    baseline: 12,
    actual: 18,
    destination: "office",
    rerouted: true,
  });
  await page.clock.runFor(3000);
  expect((await storedState(page)).trips).toHaveLength(6);
  await page.getByRole("button", { name: "주행 마치기", exact: true }).click();
  await expect(navigation).not.toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "메인 메뉴" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "주행 기록", exact: true }).click();
  await expect(page.locator(".trip-row")).toHaveCount(6);
  await expect(page.locator(".trip-row").first()).toContainText("18분");
  await page.reload();
  await page.getByRole("button", { name: "주행 기록", exact: true }).click();
  await expect(page.locator(".trip-row")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("keeping the original route includes congestion without changing habitual driving calibration", async ({
  page,
}) => {
  test.setTimeout(120000);
  await openWithControlledTime(page);
  await startNavigation(page);
  await reachCongestion(page);
  await page
    .getByRole("button", { name: "현재 경로 유지", exact: true })
    .click();
  await expect(page.locator(".navigation-destination b")).toHaveText("18:27");
  await expect(page.locator(".navigation-schedule-line")).toContainText(
    "18:35",
  );
  await page.clock.runFor(22000);
  await expect(
    page.getByRole("button", { name: "주행 마치기", exact: true }),
  ).toBeVisible();
  const state = await storedState(page);
  expect(state.trips).toHaveLength(6);
  expect(state.mileage).toBe(9843.2);
  expect(state.trips[0]).toMatchObject({
    distance: 3.2,
    actual: 27,
    baseline: 12,
    destination: "office",
    trafficDelay: 12,
  });
  expect(state.trips[0].rerouted).not.toBe(true);
  await page.getByRole("button", { name: "주행 마치기", exact: true }).click();
  await expect(page.locator(".reasoning")).toContainText("나의 패턴 3분");
});

test("ending navigation requires confirmation and an incomplete trip is never saved", async ({
  page,
}) => {
  await openWithControlledTime(page);
  const before = await storedState(page);
  const navigation = await startNavigation(page);
  await page.clock.runFor(2000);
  await page.getByRole("button", { name: "안내 종료", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "안내를 종료할까요?" });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "계속 안내", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  await expect(navigation).toBeVisible();
  await page.getByRole("button", { name: "안내 종료", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "안내 종료하기", exact: true })
    .click();
  await expect(navigation).not.toBeVisible();
  const after = await storedState(page);
  expect(after.trips).toEqual(before.trips);
  expect(after.mileage).toBe(before.mileage);
  expect(after.parking).toBe(before.parking);
  await page.reload();
  expect((await storedState(page)).trips).toHaveLength(5);
});

test("mobile guidance fills the screen and Android back respects editor and drive state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithControlledTime(page);
  await page
    .getByRole("navigation", { name: "메인 메뉴" })
    .getByRole("button", { name: "캘린더", exact: true })
    .click();
  await page.getByRole("button", { name: "일정 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await nativeBack(page);
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".calendar-page")).toBeVisible();
  await nativeBack(page);
  const navigation = await startNavigation(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  let bounds = await navigation.boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(842);
  await page.setViewportSize({ width: 844, height: 390 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  bounds = await navigation.boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(388);
  await nativeBack(page);
  const confirmation = page.getByRole("dialog", { name: "안내를 종료할까요?" });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "계속 안내", exact: true })
    .click();
  await expect(navigation).toBeVisible();
  await nativeBack(page);
  await confirmation
    .getByRole("button", { name: "안내 종료하기", exact: true })
    .click();
  await expect(navigation).not.toBeVisible();
  expect((await storedState(page)).trips).toHaveLength(5);
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
