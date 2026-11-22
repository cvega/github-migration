import { expect, test } from "@playwright/test";

test("saves and imports mappings before target users exist", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
  await page.goto("/mannequins?target=ghec");
  await hydrated;
  await expect(page.getByRole("heading", { name: "Mappings", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "Add user mapping" }).click();
  await page.getByLabel("Source identity", { exact: true }).fill("identity-e2e-alice");
  await page.getByLabel("Target username", { exact: true }).fill("target-alice");
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText("identity-e2e-alice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByLabel("CSV file").setInputFiles({
    name: "mappings.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("source_identity,target_username\nidentity-e2e-bob,target-bob\n"),
  });
  await page.getByRole("button", { name: "Import mappings" }).click();
  await expect(page.getByText("identity-e2e-bob", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("identity-e2e-alice", { exact: true })).toBeVisible();
  await expect(page.getByText("identity-e2e-bob", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
