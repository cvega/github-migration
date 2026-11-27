import { expect, test } from "@playwright/test";

test("starts enterprise profiling without selecting or loading individual namespaces", async ({ page }) => {
	const hydrated = page.waitForRequest(request => request.url().endsWith("/api/rate-limits"));
	await page.route("**/api/profile/queue?provider=bitbucket-server", route => route.fulfill({json:{pending:0,failed:0}}));
	await page.route("**/api/profile/queue", route => route.fulfill({status:202,json:{added:12,discovered:12}}));
	await page.goto("/profile");
	await hydrated;
	await page.getByRole("button",{name:"New profile"}).click();
	const submitted=page.waitForRequest(request=>request.url().endsWith("/api/profile/queue") && request.method()==="POST");
	await page.getByRole("button",{name:"Start profile"}).click();
	expect((await submitted).postDataJSON()).toEqual({sourceProvider:"bitbucket-server",scope:"enterprise",enterprise:""});
	await expect(page.getByRole("status").filter({hasText:"12 queued from 12 eligible namespaces"})).toBeVisible();
});

test("reviews and filters a completed source profile", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/profile");
	await hydrated;

	await expect(page.getByRole("heading", { name: "Source profiles", exact: true })).toBeVisible();
	await expect(page.locator("summary").filter({hasText:"e2e-source"})).toContainText("2/2 repos");
	await expect(page.locator("summary").filter({hasText:"platform/products/services"})).toContainText(
		"At least 2 projects",
	);
	const search=page.getByRole("searchbox");
	await search.fill("BITBUCKET platform");
	await expect(page.locator("main details")).toHaveCount(1);
	await expect(page.locator("main summary")).toContainText("2 repositories");
	await search.fill("does-not-exist");
	await expect(page.getByText(/No matching profiles/)).toBeVisible();
	await search.fill("");
	await page.locator("summary").filter({hasText:"e2e-source"}).click();

	await page.getByRole("link", { name: /e2e-source/ }).click();
	await expect(page).toHaveURL(/\/profile\/seed-e2e-profile$/);
	await expect(page.getByRole("heading", { name: /e2e-source/ })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Migration readiness" })).toBeVisible();
	const profileDetails = page.locator("details").filter({
		has: page.getByText("Profile details", { exact: true }),
	});
	await expect(profileDetails).not.toHaveAttribute("open", "");
	await profileDetails.locator("summary").click();
	await expect(page.getByRole("heading", { name: "Migration scale" })).toBeVisible();

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

for (const width of [1280, 390]) {
	test(`distinguishes unavailable organization resources from zero at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto("/profile/seed-e2e-profile");
		const readiness = page.getByRole("region", { name: "Migration readiness" });
		await expect(readiness.getByText("Rulesets", { exact: true }).locator("..").getByText("Unavailable", { exact: true })).toBeVisible();
		await expect(readiness.getByText("Teams", { exact: true }).locator("..").getByText("0", { exact: true })).toBeVisible();
		await readiness.screenshot({ path: testInfo.outputPath("readiness.png") });
	});
}
