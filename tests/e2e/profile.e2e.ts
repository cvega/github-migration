import { expect, test } from "@playwright/test";

test("starts enterprise profiling without selecting or loading individual namespaces", async ({ page }) => {
	const hydrated = page.waitForRequest(request => request.url().endsWith("/api/rate-limits"));
	await page.route("**/api/profile/queue?provider=bitbucket-server", route => route.fulfill({json:{pending:0,failed:0}}));
	await page.route("**/api/profile/queue", route => route.fulfill({status:202,json:{added:12,discovered:12,found:14,outOfScope:2,scopeNotice:"2 of 14 Bitbucket Server projects found are outside the configured scope (BITBUCKET_SERVER_PROJECT_KEYS)."}}));
	await page.goto("/profile");
	await hydrated;
	await page.getByRole("button",{name:"New profile"}).click();
	const submitted=page.waitForRequest(request=>request.url().endsWith("/api/profile/queue") && request.method()==="POST");
	await page.getByRole("button",{name:"Start profile"}).click();
	expect((await submitted).postDataJSON()).toEqual({sourceProvider:"bitbucket-server",scope:"enterprise",enterprise:""});
	await expect(page.getByRole("status").filter({hasText:"12 queued from 12 eligible namespaces. 2 of 14 Bitbucket Server projects found are outside the configured scope (BITBUCKET_SERVER_PROJECT_KEYS)."})).toBeVisible();
});

test("explains an enterprise discovery that is entirely outside the configured scope", async ({ page }) => {
	const hydrated = page.waitForRequest(request => request.url().endsWith("/api/rate-limits"));
	await page.route("**/api/profile/queue?provider=bitbucket-server", route => route.fulfill({json:{pending:0,failed:0}}));
	const error = "Discovery found 16 Bitbucket Server projects, but all are outside the configured scope (BITBUCKET_SERVER_PROJECT_KEYS). No profiles queued.";
	await page.route("**/api/profile/queue", route => route.fulfill({status:422,json:{error,found:16,outOfScope:16}}));
	await page.goto("/profile");
	await hydrated;
	await page.getByRole("button",{name:"New profile"}).click();
	await page.getByRole("button",{name:"Start profile"}).click();
	await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(error);
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
	test(`renders a GitLab profile whose metrics were malformed at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 844 });
		const response = await page.goto("/profile/seed-e2e-gitlab-profile");
		expect(response?.status()).toBe(200);
		const contents = page.getByRole("heading", { name: "Repository contents" }).locator("..");
		await expect(contents.getByText("Tags", { exact: true }).locator("..").getByText("Unavailable", { exact: true })).toBeVisible();
		await expect(contents.getByText("Commits", { exact: true }).locator("..").getByText("42", { exact: true })).toBeVisible();
		await expect(contents.getByText("GitLab CI to convert", { exact: true }).locator("..").getByText("At least 1", { exact: true })).toBeVisible();
		await expect(contents.getByText("Project webhooks", { exact: true }).locator("..").getByText("0", { exact: true })).toBeVisible();
		await expect(contents.getByText("Group hooks", { exact: true }).locator("..").getByText("At least 2", { exact: true })).toBeVisible();
		await expect(contents.getByText("Group hook events observed: deployment, pipeline.")).toBeVisible();
		await expect(contents.getByText(/Ancestors outside the selected namespace are not inspected/)).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		const storage = page.getByRole("heading", { name: "Source storage" }).locator("..");
		await expect(storage.getByText("Job artifacts", { exact: true }).locator("..").getByText("At least 4.0 KiB", { exact: true })).toBeVisible();
		await expect(storage.getByText("Pipeline artifacts", { exact: true }).locator("..").getByText("0 B", { exact: true })).toBeVisible();
		await expect(storage.getByText("Snippets", { exact: true })).toBeVisible();
		await expect(storage.getByText("Container registry", { exact: true }).locator("..").getByText("not-reported", { exact: true })).toBeVisible();
		await expect(contents.getByText("Branch protection rules", { exact: true }).locator("..").getByText("3", { exact: true })).toBeVisible();
		await expect(contents.getByText("Inherited branch rules", { exact: true }).locator("..").getByText("Unavailable", { exact: true })).toBeVisible();
		await expect(contents.getByText("Tag protection rules", { exact: true }).locator("..").getByText("At least 2", { exact: true })).toBeVisible();
		const risks = page.getByRole("heading", { name: "Migration risks and coverage" }).locator("..");
		await expect(risks.getByText("Protection rules to recreate", { exact: true }).locator("..").getByText("At least 5", { exact: true })).toBeVisible();
		await risks.screenshot({ path: testInfo.outputPath("gitlab-risks.png") });
		await storage.screenshot({ path: testInfo.outputPath("gitlab-storage.png") });
		await contents.screenshot({ path: testInfo.outputPath("gitlab-contents.png") });
	});
}

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

for (const width of [1280, 390]) {
	test(`shows readiness gaps and planning eligibility at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 844 });
		const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
		await page.goto("/profile/seed-e2e-incomplete-readiness");
		await hydrated;

		const readiness = page.getByRole("region", { name: "Migration readiness" });
		await expect(readiness.getByText("Ready repositories", { exact: true }).locator("..")).toHaveText("1 Ready repositories");
		await expect(readiness.getByText("Repos with incomplete scans").locator("..")).toHaveText("3 Repos with incomplete scans");
		await readiness.screenshot({ path: testInfo.outputPath("readiness-gaps-rollup.png") });

		const table = page.getByRole("table");
		const clean = table.getByRole("row").filter({ hasText: "clean-repository" });
		await expect(clean.getByText("Ready", { exact: true })).toBeVisible();

		const longName = "repository-with-a-long-name-and-incomplete-readiness-evidence";
		const partial = table.getByRole("row").filter({ hasText: longName });
		await expect(partial.getByText("Incomplete scan", { exact: true })).toBeVisible();
		await expect(partial.getByText("Branch rule scan incomplete")).toBeVisible();
		await expect(partial.getByText("Release asset scan incomplete")).toBeVisible();
		await expect(partial.getByRole("checkbox")).toBeDisabled();

		const blocked = table.getByRole("row").filter({ hasText: "blocked-repository" });
		await expect(blocked.getByText("1 blocker", { exact: true })).toBeVisible();
		await expect(blocked.getByText("Required", { exact: true })).toBeVisible();
		await expect(blocked.getByRole("checkbox")).toBeDisabled();
		await expect(blocked.getByText("Release asset scan incomplete")).toBeVisible();

		const empty = table.getByRole("row").filter({ hasText: "empty-repository" });
		await expect(empty.getByText("Not required")).toBeVisible();
		await expect(empty.getByText("Run a new profile to recheck readiness evidence.")).toBeVisible();
		const selectEmpty = empty.getByRole("checkbox", { name: "Select readiness-fixture/empty-repository" });
		await expect(selectEmpty).toBeChecked();
		await selectEmpty.focus();
		await selectEmpty.press("Space");
		await expect(selectEmpty).not.toBeChecked();
		await selectEmpty.press("Space");
		await expect(selectEmpty).toBeChecked();

		const expand = partial.getByRole("button", { name: longName });
		await expand.focus();
		await expand.press("Enter");
		await expect(expand).toHaveAttribute("aria-expanded", "true");
		await expand.press("Enter");
		await expect(expand).toHaveAttribute("aria-expanded", "false");

		const viewport = table.locator("..");
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
		await viewport.screenshot({ path: testInfo.outputPath("readiness-gaps-repositories.png") });
		if (width === 390) {
			await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
			await viewport.screenshot({ path: testInfo.outputPath("readiness-gaps-repositories-scrolled.png") });
		}
		await page.getByRole("searchbox", { name: "Filter repositories" }).fill("does-not-exist");
		await expect(page.getByText("No repositories match the current filters.")).toBeVisible();
	});
}
