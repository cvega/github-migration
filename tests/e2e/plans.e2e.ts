import { expect, test } from "@playwright/test";

test("reviews migration risks and exports the approved plan", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/profile/seed-e2e-profile");
	await hydrated;

	const plan = page.locator("section").filter({
		has: page.getByRole("heading", { name: "Build migration plan" }),
	});
	const launch = plan.getByRole("button", { name: "Launch batch" });
	const readyRepo = page.getByLabel("Select e2e-source/ready-repo");
	const blockedRepo = page.getByLabel("Select e2e-source/blocked-repo");

	await expect(readyRepo).toBeChecked();
	await expect(blockedRepo).not.toBeChecked();
	await expect(launch).toBeDisabled();

	await plan.getByLabel("Target organization").fill("migration-target");
	await expect(launch).toBeDisabled();
	await plan.getByRole("combobox", { name: "Destination", exact: true }).selectOption("ghec");
	await plan.getByLabel("Target organization").fill("migration-target");
	await expect(launch).toBeEnabled();

	await blockedRepo.check();
	const acceptBlockers = plan.getByLabel(/Accept unresolved blocking issues/);
	await expect(acceptBlockers).toBeVisible();
	await expect(launch).toBeDisabled();
	await acceptBlockers.check();
	await expect(launch).toBeEnabled();

	const readyTarget = page.getByLabel("Target repository for e2e-source/ready-repo");
	await readyTarget.fill("invalid/name");
	await expect(plan.getByText(/must be a repository name without spaces or slashes/)).toBeVisible();
	await expect(launch).toBeDisabled();
	await readyTarget.fill("ready-repository");

	const downloadPromise = page.waitForEvent("download");
	await plan.getByRole("button", { name: "Export" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("e2e-source-migration-plan.json");
	const downloadPath = await download.path();
	expect(downloadPath).not.toBeNull();
	const exported = (await Bun.file(downloadPath as string).json()) as {
		profileRunId: string;
		targetProfileId: string;
		targetOrg: string;
		items: Array<{ sourceRepo: string; targetRepo: string }>;
		reposWithBlockers: number;
		blockersAcceptedAt: string | null;
	};
	expect(exported.profileRunId).toBe("seed-e2e-profile");
	expect(exported.targetProfileId).toBe("ghec");
	expect(exported.targetOrg).toBe("migration-target");
	expect(exported.items).toEqual([
		{ sourceRepo: "e2e-source/ready-repo", targetRepo: "ready-repository" },
		{ sourceRepo: "e2e-source/blocked-repo", targetRepo: "blocked-repo" },
	]);
	expect(exported.reposWithBlockers).toBe(1);
	expect(exported.blockersAcceptedAt).toEqual(expect.any(String));
});

for (const width of [1280, 390]) {
	test(`plans colliding GitLab project names at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 844 });
		await page.goto("/profile/seed-e2e-gitlab-profile");
		const plan = page.getByRole("region", { name: "Build migration plan" });
		await plan.getByRole("button", { name: "Select all" }).click();

		const name = "payments-api-with-a-long-repository-name-for-the-migration-plan";
		const first = plan.getByLabel(`Target repository for platform/products/services/prof01/${name}`);
		const second = plan.getByLabel(`Target repository for platform/products/services/prof02/${name}`);
		await expect(first).toHaveValue(`prof01-${name}`);
		await expect(second).toHaveValue(`prof02-${name}`);
		const selectFirst = plan.getByLabel(`Select platform/products/services/prof01/${name}`);
		await selectFirst.uncheck();
		await expect(second).toHaveValue(`prof02-${name}`);
		await selectFirst.check();
		await expect(first).toHaveValue(`prof01-${name}`);
		await plan.getByRole("combobox", { name: "Destination", exact: true }).selectOption("ghec");
		await plan.getByLabel("Target organization").fill("migration-target");
		const launch = plan.getByRole("button", { name: "Launch batch" });
		await expect(launch).toBeEnabled();

		await first.focus();
		await first.press("ControlOrMeta+a");
		await first.press("Backspace");
		await expect(plan.getByText(/must be a repository name without spaces or slashes/)).toBeVisible();
		await first.fill(`PROF02-${name}`);
		await expect(plan.getByText(/is used more than once/)).toBeVisible();
		await expect(launch).toBeDisabled();
		await first.fill("payments-custom");
		await selectFirst.uncheck();
		await selectFirst.check();
		await expect(first).toHaveValue("payments-custom");
		await expect(launch).toBeEnabled();
		await expect(second).toHaveValue(`prof02-${name}`);

		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
		expect(await first.locator("..").evaluate((row) => row.scrollWidth)).toBe(
			await first.locator("..").evaluate((row) => row.clientWidth),
		);
		await plan.screenshot({ path: testInfo.outputPath("gitlab-migration-plan.png") });
	});
}
