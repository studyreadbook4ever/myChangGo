import { expect, test, type Page } from "@playwright/test";

async function openCalendar(page: Page) {
  await page
    .getByRole("navigation", { name: "메인 메뉴" })
    .getByRole("button", { name: "캘린더", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "나의 일정" })).toBeVisible();
}

async function addCalendarEvent(
  page: Page,
  title: string,
  options: { date?: string; time?: string; duration?: string } = {},
) {
  await page.getByRole("button", { name: "일정 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새로운 일정" });
  await dialog.getByLabel("일정 이름", { exact: true }).fill(title);
  if (options.date)
    await dialog.getByLabel("날짜", { exact: true }).fill(options.date);
  if (options.time)
    await dialog.getByLabel("시작 시간", { exact: true }).fill(options.time);
  if (options.duration)
    await dialog.getByLabel("일정 길이").fill(options.duration);
  await dialog.getByRole("button", { name: "일정 추가", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("calendar time, destination, and arrival buffer update the departure recommendation", async ({
  page,
}) => {
  await expect(page.locator(".recommendation-time strong")).toHaveText("18:00");
  await openCalendar(page);
  await page
    .getByRole("button", { name: "브랜드 프로젝트 미팅 일정 수정" })
    .click();
  const dialog = page.getByRole("dialog", { name: "일정 수정하기" });
  await dialog.getByLabel("시작 시간", { exact: true }).fill("19:00");
  await dialog.getByLabel("장소", { exact: true }).selectOption("cafe");
  await dialog.getByLabel("도착 여유 시간").fill("15");
  await dialog.getByRole("button", { name: "변경 저장" }).click();
  await page
    .getByRole("button", {
      name: "브랜드 프로젝트 미팅 리버사이드 카페 경로 보기",
    })
    .click();

  // 19:00 minus 8 minutes driving, 3 parking, 2 walking, and 15 buffer.
  await expect(page.locator(".recommendation-time strong")).toHaveText("18:32");
  await expect(page.locator(".map-location-card strong")).toHaveText(
    "리버사이드 카페",
  );
  await expect(page.locator(".reasoning")).toContainText(
    "15분 먼저 도착하고 싶어요",
  );
  await page.reload();
  await expect(page.locator(".recommendation-time strong")).toHaveText("18:32");
  await expect(page.locator(".map-location-card strong")).toHaveText(
    "리버사이드 카페",
  );
});

test("calendar creation, editing, and deletion survive page reloads", async ({
  page,
}) => {
  await openCalendar(page);
  await addCalendarEvent(page, "타이어 상태 확인", {
    time: "20:15",
    duration: "45",
  });
  await page.reload();
  await openCalendar(page);
  await expect(
    page.getByRole("heading", { name: "타이어 상태 확인", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "타이어 상태 확인 일정 수정" })
    .click();
  const dialog = page.getByRole("dialog", { name: "일정 수정하기" });
  await dialog
    .getByLabel("일정 이름", { exact: true })
    .fill("타이어와 브레이크 확인");
  await dialog.getByLabel("도착 여유 시간").fill("0");
  await dialog.getByRole("button", { name: "변경 저장" }).click();
  await page.reload();
  await openCalendar(page);
  const card = page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: "타이어와 브레이크 확인",
        exact: true,
      }),
    });
  await expect(card).toContainText("20:15");
  await expect(card).toContainText("21:00");
  await expect(card).toContainText("일정 시작에 맞춰 도착");
  await card
    .getByRole("button", { name: "타이어와 브레이크 확인 일정 수정" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "유지하기" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "일정 수정하기" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "삭제", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "삭제하기", exact: true })
    .click();
  await page.reload();
  await openCalendar(page);
  await expect(
    page.getByRole("heading", { name: "타이어와 브레이크 확인", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "브랜드 프로젝트 미팅", exact: true }),
  ).toBeVisible();
});

test("maintenance skips candidate times occupied by a calendar event", async ({
  page,
}) => {
  await openCalendar(page);
  await addCalendarEvent(page, "주말 이동 일정", {
    date: "2026-09-26",
    time: "09:30",
    duration: "120",
  });
  await page
    .getByRole("navigation", { name: "메인 메뉴" })
    .getByRole("button", { name: "내 차량", exact: true })
    .click();
  await expect(page.locator(".maintenance-suggestion h3")).toHaveText(
    "목요일 오후 6시 30분",
  );
  await page.getByRole("button", { name: "내 캘린더에 정비 추가" }).click();
  await page.reload();
  await openCalendar(page);
  await page.getByRole("button", { name: /^2026년 9월 24일 목요일,/ }).click();
  const maintenance = page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "엔진오일 점검", exact: true }),
    });
  await expect(maintenance).toBeVisible();
  await expect(maintenance).toContainText("18:30");
  await expect(maintenance).toContainText("19:30");
  await expect(maintenance).toContainText("그린 오토케어");
  await maintenance
    .getByRole("button", { name: "엔진오일 점검 그린 오토케어 경로 보기" })
    .click();
  await expect(page.locator(".day-weather")).toContainText("9월 24일 목요일");
  await expect(page.locator(".map-location-card strong")).toHaveText(
    "그린 오토케어",
  );
  await openCalendar(page);
  await page.getByRole("button", { name: /^2026년 9월 26일 토요일,/ }).click();
  await expect(
    page.getByRole("heading", { name: "주말 이동 일정", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "엔진오일 점검", exact: true }),
  ).toHaveCount(0);
});

test("calendar and editor fit mobile screens and Escape restores editor focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCalendar(page);
  await expect(
    page.getByRole("button", { name: "데모 오늘", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const addButton = page.getByRole("button", {
    name: "일정 추가",
    exact: true,
  });
  await addButton.click();
  const dialog = page.getByRole("dialog", { name: "새로운 일정" });
  await expect(dialog.getByLabel("일정 이름", { exact: true })).toBeFocused();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(addButton).toBeFocused();
  await page.getByRole("button", { name: "다음 달" }).click();
  await expect(
    page.getByRole("heading", { name: "2026년 10월" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "데모 오늘", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^2026년 9월 23일 수요일,/ }),
  ).toHaveAttribute("aria-pressed", "true");
});
