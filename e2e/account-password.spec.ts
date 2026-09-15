import { expect, test } from "@playwright/test";

test("password form accepts six-character mixed passwords without requiring symbols or both cases", async ({
  page,
}) => {
  const user = {
    id: "password-policy-preview",
    username: "player",
    role: "PLAYER",
    isActive: true,
    balance: 1000,
    walletVersion: 1,
  };
  const authResponse = {
    token: "preview",
    user,
    accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const changes: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/refresh") return route.fulfill({ json: authResponse });
    if (path === "/api/auth/change-password") {
      changes.push(route.request().postDataJSON());
      return route.fulfill({ json: authResponse });
    }
    return route.fulfill({
      status: 404,
      json: { code: "NOT_FOUND", message: "unexpected", requestId: "preview" },
    });
  });
  await page.goto("/account");
  await page.getByLabel("目前密碼", { exact: true }).fill("Previous!Secure2026");
  const password = page.getByLabel("新密碼", { exact: true });
  const confirm = page.getByLabel("確認新密碼", { exact: true });
  for (const value of ["ab123", "abcdef", "123456", "abc 12"]) {
    await password.fill(value);
    await confirm.fill(value);
    await page.getByRole("button", { name: "更新密碼", exact: true }).click();
    expect(await password.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
    expect(changes).toHaveLength(0);
  }
  for (const value of ["abc123", "ABC123", "abc12!"]) {
    await password.fill(value);
    expect(await password.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);
  }
  await password.fill("abc123");
  await confirm.fill("abc123");
  await page.getByRole("button", { name: "更新密碼", exact: true }).click();
  await expect(page.getByText("密碼已更新，其他既有登入階段已失效。")).toBeVisible();
  expect(changes).toEqual([{ currentPassword: "Previous!Secure2026", newPassword: "abc123" }]);
});
