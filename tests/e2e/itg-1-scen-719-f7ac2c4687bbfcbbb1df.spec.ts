import { test, expect } from "@playwright/test";

const REPORT_INPUT_PATH = "/panels/scr-1789983412165.html";
const REPORT_MANAGEMENT_PATH = "/panels/scr-1789983420567.html";

test("SCEN-719: リーダーが指定した日報IDに対応する日報データが取得されて画面に表示される", async ({ page }) => {
  // 前提: 詳細確認の対象となる、他と混同されない一意な内容の提出済み日報を用意する。
  await page.goto(REPORT_INPUT_PATH);

  const dailyWorkInput = page.getByTestId("daily-work-input");
  const submitButton = page.getByTestId("submit-button");
  await expect(dailyWorkInput).toBeVisible();

  const workContent = `SCEN-719検証用の本日の業務内容_${Date.now()}`;
  await dailyWorkInput.fill(workContent);
  await submitButton.click();

  const submitStatus = page.getByTestId("submit-status");
  await expect(submitStatus).toBeVisible();
  await expect(submitStatus).toContainText(/完了|成功|提出しました|送信しました/);

  // 1. 日報確認・管理画面にアクセスする
  await page.goto(REPORT_MANAGEMENT_PATH);

  const submittedTable = page.getByTestId("submitted-reports-table");
  await expect(submittedTable).toBeVisible();

  // 2. 日報一覧から特定の日報ID（一意な業務内容を持つ行）を指定して詳細確認を実行する
  const targetRow = submittedTable.locator("tbody tr", { hasText: workContent });
  await expect(targetRow).toHaveCount(1);

  const reporterName = (await targetRow.locator("td").first().innerText()).trim();
  expect(reporterName).not.toBe("");

  const detailButton = targetRow.getByRole("button", { name: "詳細" });
  await detailButton.click();

  // 3. 指定した日報IDに対応する日報データが画面に表示されるまで待機する
  const detailModal = page.locator("#detail-modal-overlay");
  await expect(detailModal).toBeVisible();

  // 期待結果: 指定した日報IDに対応する日報データ（報告者名、報告日、「今日何をしたか」の入力内容）が正確に表示される
  const detailReporter = page.locator("#detail-reporter");
  await expect(detailReporter).toBeVisible();
  await expect(detailReporter).toContainText(reporterName);

  const detailDate = page.locator("#detail-date");
  await expect(detailDate).toBeVisible();
  const today = new Date();
  await expect(detailDate).toContainText(String(today.getFullYear()));
  await expect(detailDate).not.toHaveText("");

  const detailContent = page.locator("#detail-content");
  await expect(detailContent).toBeVisible();
  await expect(detailContent).toContainText(workContent);

  // 指定した日報以外の内容が混在して表示されていないことを確認する
  await expect(detailContent).not.toContainText("undefined");
});
