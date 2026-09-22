import { test, expect } from "@playwright/test";

const REPORT_INPUT_PATH = "/panels/scr-1789983412165.html";
const REPORT_MANAGEMENT_PATH = "/panels/scr-1789983420567.html";

test("SCEN-694: 報告者が日報を入力・送信すると、内容が管理画面まで引き継がれて記録される", async ({ page }) => {
  // 1. 日報入力・提出画面にアクセスし、業務終了時刻到達後のシステム状態を確認する
  await page.goto(REPORT_INPUT_PATH);

  const dailyWorkInput = page.getByTestId("daily-work-input");
  const submitButton = page.getByTestId("submit-button");

  await expect(dailyWorkInput).toBeVisible();
  await expect(dailyWorkInput).toBeEnabled();
  await expect(dailyWorkInput).toHaveValue("");
  await expect(submitButton).toBeEnabled();

  // 2. 入力フィールド（『今日何をしたか』）に業務内容テキストを入力する
  const workContent = `本日はSCEN-694の検証作業を実施した_${Date.now()}`;
  await dailyWorkInput.fill(workContent);

  // 3. 送信ボタンを押す
  await submitButton.click();

  // 4. 提出完了メッセージが表示されることを確認する
  const submitStatus = page.getByTestId("submit-status");
  await expect(submitStatus).toBeVisible();
  await expect(submitStatus).toContainText(/完了|成功|提出しました|送信しました/);

  // 管理者（リーダー）へのメール通知が送信される（画面上の送信完了表示で確認できる）
  const emailStatus = page.getByTestId("email-status");
  await expect(emailStatus).toBeVisible();
  await expect(emailStatus).toContainText(/送信|完了|成功/);

  // 5. 日報確認・管理画面にアクセスし、送信した日報内容が一覧に表示されていることを確認する
  await page.goto(REPORT_MANAGEMENT_PATH);

  const submittedTable = page.getByTestId("submitted-reports-table");
  await expect(submittedTable).toBeVisible();

  const submittedRow = submittedTable.locator("tbody tr", { hasText: workContent });
  await expect(submittedRow).toHaveCount(1);

  // 6. 送信した日報の入力内容（業務内容テキスト）と報告者情報が正確に記録されていることを確認する
  await expect(submittedRow).toContainText(workContent);

  const reporterCell = submittedRow.locator("td").first();
  await expect(reporterCell).not.toHaveText("");

  const submittedTimeCell = submittedRow.locator("td").nth(1);
  await expect(submittedTimeCell).not.toHaveText("");
});
