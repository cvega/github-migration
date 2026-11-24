import { expect, test } from "@playwright/test";

test("saves and imports mappings before target users exist", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/mannequins?target=ghec");
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
  const edit = page.getByRole("button", { name: "Edit mapping for identity-e2e-alice" });
  const remove = page.getByRole("button", { name: "Remove mapping for identity-e2e-alice" });

  // Hold hydration so the server-rendered controls can be tested without a timing race.
  const scripts = Promise.withResolvers<void>();
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await scripts.promise;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: "commit" });
    await expect(edit).toBeVisible();
    await expect(edit).toBeDisabled();
    await expect(page.getByRole("button", { name: "Import CSV" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add user mapping" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Teams/ })).toBeDisabled();
    await expect(remove).toBeEnabled();
  } finally {
    scripts.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }

  await expect(page.getByText("identity-e2e-alice", { exact: true })).toBeVisible();
  await expect(page.getByText("identity-e2e-bob", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const button of [edit, remove]) {
    await expect(button).toHaveCSS("width", "32px");
    await expect(button).toHaveCSS("height", "32px");
  }
  await edit.click();
  const login = page.getByLabel("Target username", { exact: true });
  await expect(login).toBeFocused();
  await login.fill("discarded-edit");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeFocused();
  await edit.press("Enter");
  await expect(login).toHaveValue("target-alice");
  await login.fill("updated-alice");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("@updated-alice", { exact: true })).toBeVisible();
  await expect(edit).toBeFocused();
  await page.reload();
  await expect(page.getByText("@updated-alice", { exact: true })).toBeVisible();
  await remove.click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByText("identity-e2e-bob", { exact: true })).toBeVisible();
});
