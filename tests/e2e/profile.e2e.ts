import { expect, test } from "@playwright/test";

test("reviews and filters a completed source profile", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/profile");
	await hydrated;

	await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
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
	await expect(page.getByText("Git repository concerns")).toBeVisible();
	await expect(page.getByText(/The size of the largest blob object: 114 MiB/)).toBeVisible();
	await expect(page.getByRole("listitem").getByText("refs/heads/main:fixtures/archive.bin")).toBeVisible();
	await page.locator("summary").filter({ hasText: "All Git measurements" }).click();
	await expect(page.getByText("Total number of distinct commit objects")).toBeVisible();
	await expect(page.getByText("18,420")).toBeVisible();
	await expect(page.getByText("Total size of distinct blob objects")).toBeVisible();
	await expect(page.getByText("1.0 GiB")).toBeVisible();

	await page.getByLabel("Filter by readiness").selectOption("all");
	const readyRepo = page.getByRole("button", { name: "ready-repo" });
	await readyRepo.click();
	await expect(page.getByText("Fixture clone failure")).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry repository" })).toBeVisible();
});