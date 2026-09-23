import { chromium } from "@playwright/test";
import { mkdir, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Run the web preview first: npm run dev -- --port 4173
// A separate, fresh browser profile keeps your own saved demo data untouched.
await mkdir("artifacts/recording", { recursive: true });
await mkdir("docs", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: {
    dir: "artifacts/recording",
    size: { width: 1920, height: 1080 },
  },
});
const page = await context.newPage();
await page.goto(process.env.DEMO_URL || "http://127.0.0.1:4173");
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: "docs/desktop.png", fullPage: true });
await page.getByRole("button", { name: "캘린더", exact: true }).first().click();
await page.screenshot({ path: "docs/calendar.png", fullPage: true });
await page.waitForTimeout(4000);
await page.getByRole("button", { name: "드라이브", exact: true }).click();
await page.waitForTimeout(1800);
await page.getByRole("button", { name: "주행 시작", exact: true }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: "docs/presentation.png" });
await page
  .getByRole("button", { name: "우회 경로로 변경", exact: true })
  .waitFor({ timeout: 45000 });
await page.waitForTimeout(3500);
await page
  .getByRole("button", { name: "우회 경로로 변경", exact: true })
  .click();
await page
  .getByRole("button", { name: "주행 마치기", exact: true })
  .waitFor({ timeout: 60000 });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "주행 마치기", exact: true }).click();
await page.getByRole("button", { name: "주행 기록", exact: true }).click();
await page.waitForTimeout(2500);
const video = page.video();
await context.close();
await rename(await video.path(), "artifacts/DriveMate-demo.webm");

const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  deviceScaleFactor: 1,
});
await phone.goto(process.env.DEMO_URL || "http://127.0.0.1:4173");
await phone.evaluate(() => document.fonts.ready);
await phone.screenshot({ path: "docs/mobile.png", fullPage: true });
await phone.getByRole("button", { name: "주행 시작", exact: true }).click();
await phone.waitForTimeout(700);
await phone.screenshot({ path: "docs/mobile-navigation.png" });
await browser.close();
const result = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    "artifacts/DriveMate-demo.webm",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    "docs/DriveMate-demo.mp4",
  ],
  { stdio: "inherit" },
);
if (result.error || result.status !== 0)
  throw new Error(
    "Video conversion failed. Install ffmpeg; the original WebM is in artifacts/.",
  );
console.log("Saved docs/DriveMate-demo.mp4 and navigation screenshots.");
