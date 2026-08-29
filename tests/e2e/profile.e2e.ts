import { expect, test } from "@playwright/test";

test("reviews and filters a completed source assessment", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/profile");
	await hydrated;

	await expect(page.getByRole("heading", { name: "Assess" })).toBeVisible();
	await expect(page.getByRole("link", { name: /e2e-source/ })).toContainText("2/2 repos");
	await expect(page.getByRole("link", { name: /platform\/products\/services/ })).toContainText(
		"At least 2 projects",
	);
	await expect(page.getByRole("link", { name: /PLATFORM/ })).toContainText("2 projects");

	await page.getByRole("link", { name: /e2e-source/ }).click();
	await expect(page).toHaveURL(/\/profile\/seed-e2e-profile$/);
	await expect(page.getByRole("heading", { name: /e2e-source/ })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Migration scale" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Migration readiness" })).toBeVisible();

	const filtered = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return (
			url.pathname === "/api/profile/seed-e2e-profile" &&
			url.searchParams.get("readiness") === "blockers"
		);
	});
	await page.getByLabel("Filter by readiness").selectOption("blockers");
	expect((await filtered).ok()).toBe(true);

	const blockedRepo = page.getByRole("button", { name: "blocked-repo" });
	await expect(blockedRepo).toBeVisible();
	await expect(page.getByRole("button", { name: "ready-repo" })).toHaveCount(0);
	await blockedRepo.click();
	await expect(blockedRepo).toHaveAttribute("aria-expanded", "true");
});