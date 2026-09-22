import { test, expect } from "@playwright/test";

const REPORT_INPUT_PATH = "/panels/scr-1789983412165.html";
const REPORT_MANAGEMENT_PATH = "/panels/scr-1789983420567.html";

test("SCEN-717: リーダーが日報詳細確認画面にアクセスできて、詳細画面が表示される", async ({ page }) => {
  // 前提: 詳細確認の対象となる提出済み日報を1件用意する。
  await page.goto(REPORT_INPUT_PATH);

  const dailyWorkInput = page.getByTestId("daily-work-input");
  const submitButton = page.getByTestId("submit-button");
  await expect(dailyWorkInput).toBeVisible();

  const workContent = `SCEN-717検証用の本日の業務内容_${Date.now()}`;
  await dailyWorkInput.fill(workContent);
  await submitButton.click();

  const submitStatus = page.getByTestId("submit-status");
  await expect(submitStatus).toBeVisible();
  await expect(submitStatus).toContainText(/完了|成功|提出しました|送信しました/);

  // 1. リーダーユーザーでシステムにログインする
  // 2. 日報確認・管理画面にアクセスする
  await page.goto(REPORT_MANAGEMENT_PATH);

  const submittedTable = page.getByTestId("submitted-reports-table");
  await expect(submittedTable).toBeVisible();

  const targetRow = submittedTable.locator("tbody tr", { hasText: workContent });
  await expect(targetRow).toHaveCount(1);

  const reporterName = (await targetRow.locator("td").first().innerText()).trim();
  expect(reporterName).not.toBe("");

  // 3. 提出済みの日報一覧から1件を選択して詳細確認ボタンをクリックする
  const detailButton = targetRow.getByRole("button", { name: "詳細" });
  await detailButton.click();

  // 4. 日報詳細確認画面が表示されるまで待機する
  const detailModal = page.locator("#detail-modal-overlay");
  await expect(detailModal).toBeVisible();

  // 期待結果: 報告者名、提出日時、『今日何をしたか』の入力内容（テキスト）が画面上に表示される
  const detailReporter = page.locator("#detail-reporter");
  await expect(detailReporter).toBeVisible();
  await expect(detailReporter).toContainText(reporterName);

  const detailDate = page.locator("#detail-date");
  await expect(detailDate).toBeVisible();
  await expect(detailDate).not.toHaveText("");

  const detailContent = page.locator("#detail-content");
  await expect(detailContent).toBeVisible();
  await expect(detailContent).toContainText(workContent);
});
