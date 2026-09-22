import { test, expect } from "@playwright/test";

const REPORT_INPUT_PATH = "/panels/scr-1789983412165.html";

test("SCEN-715: リーダーが管理画面へ遷移したとき、提出済み日報一覧と未提出者一覧が表示される", async ({ page }) => {
  // 1. リーダーユーザーでシステムにログインする（日報入力・提出画面がログイン後の表示画面）
  await page.goto(REPORT_INPUT_PATH);
  await expect(page.getByTestId("daily-work-input")).toBeVisible();

  // 2. 日報入力・提出画面から日報確認・管理画面へのナビゲーション要素を操作して遷移する
  const navToManagement = page.getByTestId("back-to-dashboard");
  await expect(navToManagement).toBeVisible();
  await navToManagement.click();

  // 3. 日報確認・管理画面の読み込み完了を待つ
  await page.waitForURL(/scr-1789983420567\.html/);

  const submittedTable = page.getByTestId("submitted-reports-table");
  const unsubmittedTable = page.getByTestId("unsubmitted-users-table");
  await expect(submittedTable).toBeVisible();
  await expect(unsubmittedTable).toBeVisible();

  // (1) 提出済み日報一覧：提出済みユーザー（最大5人まで）の日報が
  //     日付・ユーザー名・提出時刻とともに表示される
  const submittedRows = submittedTable.locator("tbody tr");
  const submittedRowCount = await submittedRows.count();
  expect(submittedRowCount).toBeLessThanOrEqual(5);
  for (let i = 0; i < submittedRowCount; i++) {
    const row = submittedRows.nth(i);
    const cells = row.locator("td");
    await expect(cells.first()).not.toHaveText("");
    await expect(cells.nth(1)).not.toHaveText("");
  }

  // (2) 未提出者一覧：本日の日報を未提出のユーザー名が一覧表示される
  const unsubmittedRows = unsubmittedTable.locator("tbody tr");
  const unsubmittedRowCount = await unsubmittedRows.count();
  for (let i = 0; i < unsubmittedRowCount; i++) {
    await expect(unsubmittedRows.nth(i).locator("td").first()).not.toHaveText("");
  }

  // 画面遷移が完全に成立し、前画面（日報入力・提出画面）には戻らないことを確認する
  await expect(page).toHaveURL(/scr-1789983420567\.html/);
  await expect(page.getByTestId("daily-work-input")).toHaveCount(0);
});
