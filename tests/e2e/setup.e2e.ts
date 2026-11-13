import { expect, test } from "@playwright/test";

test("reports server configuration readiness and opens profile", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/setup");
	await hydrated;

	await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
	await expect(page.getByText("Source setup required", { exact: true })).toBeVisible();
	await expect(page.getByText("Migration setup incomplete", { exact: true })).toBeVisible();

	await expect(page.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "GitLab", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Bitbucket Server", exact: true })).toBeVisible();
	await expect(page.getByText("Missing credentials", { exact: true })).toHaveCount(3);

	await expect(page.getByRole("heading", { name: "GitHub Enterprise Cloud" })).toBeVisible();
	await expect(page.getByText("Execution setup incomplete", { exact: true })).toBeVisible();
	await expect(page.getByText("test-target-org", { exact: true })).toBeVisible();
	await expect(page.getByText("Blocked", { exact: true })).toHaveCount(3);

	await page.getByRole("link", { name: "Open profile" }).click();
	await expect(page).toHaveURL(/\/profile$/);
	await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
});