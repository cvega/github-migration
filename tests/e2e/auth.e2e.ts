import { expect, test } from "@playwright/test";

test("rejects invalid credentials without revealing the username", async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill("missing-user");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toHaveText("Invalid username or password.");
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});

test("signs out a separately authenticated session", async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill("e2e-admin");
  await page.getByLabel("Password").fill("e2e-bootstrap-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("summary").click();
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});

test("creates and manages an operator", async ({ browser, page }) => {
  const username = `operator-${Date.now()}`;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/admin/users");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Display name").fill("E2E Operator");
  await page.getByRole("button", { name: "Add user" }).click();

  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole("heading", { name: "User created" })).toBeVisible();
  await expect(page.getByText(`${username} can now sign in.`, { exact: true })).toBeVisible();
  await expect(page.getByText(/Copy this password now/)).toBeVisible();
  const temporaryPassword = await page.locator("#temporary-password").textContent();
  await page.getByRole("button", { name: "Copy temporary password" }).click();
  await expect(page.getByText("Copied to clipboard.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Temporary password copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(temporaryPassword);

  if (!temporaryPassword) throw new Error("Temporary password was not rendered");
  const operatorContext = await browser.newContext({ storageState: undefined });
  const operatorPage = await operatorContext.newPage();
  await operatorPage.goto("/login");
  await operatorPage.getByLabel("Username").fill(username);
  await operatorPage.getByLabel("Password").fill(temporaryPassword);
  await operatorPage.getByRole("button", { name: "Sign in" }).click();
  await expect(operatorPage).toHaveURL(/\/account\/password$/);
  await operatorPage.getByLabel("Current password").fill(temporaryPassword);
  await operatorPage.getByLabel("New password", { exact: true }).fill("updated operator password");
  await operatorPage.getByLabel("Confirm new password").fill("updated operator password");
  await operatorPage.getByRole("button", { name: "Change password" }).click();
  await expect(operatorPage).toHaveURL(/\/$/);
  await operatorContext.close();

  await expect(page.getByLabel(`Manage ${username}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "User created" })).toBeVisible();
  await page.getByRole("button", { name: "Add another user" }).click();
  await expect(page.getByRole("heading", { name: "Add user" })).toBeVisible();
  await page.getByLabel(`Manage ${username}`).click();
  await expect(page.getByRole("heading", { name: "E2E Operator" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disable user" })).toBeVisible();
});