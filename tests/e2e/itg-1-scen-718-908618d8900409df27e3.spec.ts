import { test, expect } from "@playwright/test";

const REPORT_MANAGEMENT_PATH = "/panels/scr-1789983420567.html";

test("SCEN-718: リーダー以外のユーザーが日報詳細確認画面へのアクセスを拒否される", async ({ page }) => {
  // 1. リーダー以外のユーザー（例：報告者権限のユーザー）でシステムにログインする
  //    （サンプル画面はユーザー種別を選択してログインする手段を持たないため、
  //     リーダー権限を持たない状態のセッションで直接アクセスを試みることでこの前提を再現する。
  //     詳細は .aivic/batches/5/unresolved.md を参照）
  // 2. 日報確認・管理画面へアクセスしようとする（URLを直接入力または遷移を試みる）
  const response = await page.goto(REPORT_MANAGEMENT_PATH);

  // 期待結果: 日報確認・管理画面への遷移が拒否され、アクセス権限がないことを示す
  // エラーメッセージが画面に表示される、または403 Forbiddenエラーが返却される
  const isForbiddenResponse = response !== null && response.status() === 403;

  const permissionDeniedMessage = page.getByText(
    /アクセス権限がありません|権限がありません|アクセスが拒否されました|許可されていません|Forbidden/i
  );
  const isMessageVisible = await permissionDeniedMessage.isVisible().catch(() => false);

  expect(isForbiddenResponse || isMessageVisible).toBe(true);
});
