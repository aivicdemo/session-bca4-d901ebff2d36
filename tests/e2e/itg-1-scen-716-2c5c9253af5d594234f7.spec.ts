import { test, expect } from "@playwright/test";

const REPORT_INPUT_PATH = "/panels/scr-1789983412165.html";

test("SCEN-716: リーダーでない権限のユーザーが管理画面へアクセスしようとするとアクセスが拒否される", async ({ page }) => {
  // 1. テスト用ユーザー（リーダー権限なし）でログインする
  await page.goto(REPORT_INPUT_PATH);

  // 2. 日報入力・提出画面が表示されていることを確認する
  await expect(page.getByTestId("daily-work-input")).toBeVisible();

  // 3. 日報確認・管理画面へのナビゲーションリンク（ボタン）をクリックして遷移を試みる
  const navToManagement = page.getByTestId("back-to-dashboard");
  await expect(navToManagement).toBeVisible();

  // ネットワークタブ相当：管理画面へのリクエストのレスポンスを検証する
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("scr-1789983420567")),
    navToManagement.click(),
  ]);

  // リクエストに対して HTTP 403（Forbidden）が返却されることを確認する
  expect(response.status()).toBe(403);

  // 日報確認・管理画面への遷移は成立せず、日報入力・提出画面のままとなるか、
  // またはエラーダイアログ/エラーメッセージが表示されることを確認する
  if (/scr-1789983412165\.html/.test(page.url())) {
    await expect(page.getByTestId("daily-work-input")).toBeVisible();
  } else {
    await expect(
      page.getByRole("alertdialog").or(page.getByText(/エラー|権限がありません|アクセスできません/))
    ).toBeVisible();
  }

  // ユーザーは管理画面の内容を閲覧できない状態が保証される
  await expect(page.getByTestId("submitted-reports-table")).toHaveCount(0);
  await expect(page.getByTestId("unsubmitted-users-table")).toHaveCount(0);
});
