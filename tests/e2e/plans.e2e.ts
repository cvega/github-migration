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
		targetOrg: string;
		items: Array<{ sourceRepo: string; targetRepo: string }>;
		reposWithBlockers: number;
		blockersAcceptedAt: string | null;
	};
	expect(exported.profileRunId).toBe("seed-e2e-profile");
	expect(exported.targetOrg).toBe("migration-target");
	expect(exported.items).toEqual([
		{ sourceRepo: "e2e-source/ready-repo", targetRepo: "ready-repository" },
		{ sourceRepo: "e2e-source/blocked-repo", targetRepo: "blocked-repo" },
	]);
	expect(exported.reposWithBlockers).toBe(1);
	expect(exported.blockersAcceptedAt).toEqual(expect.any(String));
});