import { test, expect } from "@playwright/test";

const REPORT_INPUT_PATH = "/panels/scr-1789983412165.html";
const REPORT_MANAGEMENT_PATH = "/panels/scr-1789983420567.html";

test("SCEN-714: リーダーが日報入力画面から管理画面へ戻ると、アクセス権限が検証されて管理画面が表示される", async ({ page }) => {
  // 1. リーダーユーザーでログイン済みの状態で日報入力・提出画面を表示する
  await page.goto(REPORT_INPUT_PATH);
  await expect(page.getByTestId("daily-work-input")).toBeVisible();

  // 2. 日報入力・提出画面上の「管理画面へ戻る」ボタン（ナビゲーションリンク）をクリックする
  const backToDashboardLink = page.getByTestId("back-to-dashboard");
  await expect(backToDashboardLink).toBeVisible();
  await backToDashboardLink.click();

  // 3. 画面遷移が開始され、ブラウザのURL変更を確認する
  await page.waitForURL(/scr-1789983420567\.html/);
  await expect(page).toHaveURL(/scr-1789983420567\.html/);

  // 4. 遷移完了後、日報確認・管理画面が表示されたことを確認する
  //    （管理画面固有のUIコンポーネント：ヘッダー相当の見出し、未提出者一覧、リマインダー管理パネル）
  await expect(page.getByText("日報確認・管理").first()).toBeVisible();
  await expect(page.getByText("未提出者").first()).toBeVisible();
  await expect(page.getByTestId("unsubmitted-users-table")).toBeVisible();
  await expect(page.getByText("リマインダー設定").first()).toBeVisible();
  await expect(page.getByTestId("reminder-time-input")).toBeVisible();
  await expect(page.getByTestId("save-reminder-settings-btn")).toBeVisible();

  // ブラウザの戻るボタンで日報入力・提出画面へ戻ることができることを確認する
  await page.goBack();
  await expect(page).toHaveURL(/scr-1789983412165\.html/);
  await expect(page.getByTestId("daily-work-input")).toBeVisible();
});
