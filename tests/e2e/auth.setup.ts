import { expect, test as setup } from "@playwright/test";

const authState = ".e2e-data/auth-state.json";

setup("authenticate as the bootstrap administrator", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("e2e-admin");
  await page.getByLabel("Password").fill("e2e-bootstrap-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.context().storageState({ path: authState });
});