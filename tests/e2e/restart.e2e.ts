import { expect, test } from "@playwright/test";

test("confirms ambiguous remote state before offering restart credentials", async ({ page }, info) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate/seed-e2e-reconciliation");
	await hydrated;

	await expect(page.getByText("Review required", { exact: true })).toBeVisible();
	const reviewButton = page.getByRole("button", { name: "Review remote status" });
	await expect(reviewButton).toHaveCSS("height", "28px");
	await expect(reviewButton).toHaveAttribute("aria-expanded", "false");
	await reviewButton.click();
	await expect(reviewButton).toHaveAttribute("aria-expanded", "true");

	const review = page.getByRole("dialog", { name: "Review remote migration status" });
	await expect(review).toBeVisible();
	const confirm = review.getByRole("button", { name: "Confirm remote status" });
	await expect(confirm).toBeDisabled();
	await review
		.getByLabel(/Type target-review\/repository-review to confirm/)
		.fill("target-review/repository-review");
	await expect(confirm).toBeEnabled();

	const confirmation = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/migrate/seed-e2e-reconciliation/confirm-restart") &&
			response.request().method() === "POST",
	);
	await confirm.click();
	expect((await confirmation).ok()).toBe(true);
	await expect(review).not.toBeVisible();
	await expect(
		page
			.getByRole("region", {
				name: "source-review/repository-review to target-review/repository-review",
			})
			.getByText("Failed", { exact: true }),
	).toBeVisible();

	const persisted = await page.request.get("/api/migrate/seed-e2e-reconciliation");
	expect(persisted.ok()).toBe(true);
	expect((await persisted.json()).state).toBe("failed");

	const restartButton = page.getByRole("button", { name: "Restart", exact: true });
	await expect(restartButton).toHaveAttribute("aria-expanded", "false");
	await restartButton.click();
	await expect(restartButton).toHaveAttribute("aria-expanded", "true");

	const restart = page.getByRole("dialog", { name: "Restart Migration" });
	await expect(restart).toBeVisible();
	await expect(restart.getByRole("heading", { name: "Source Authentication" })).toBeVisible();
	await expect(restart.getByRole("heading", { name: "Target Authentication" })).toBeVisible();
	await expect(restart.getByLabel("Personal access token", { exact: true })).toHaveCount(2);
	const saved = restart.getByRole("checkbox", { name: "Use each migration's saved options" });
	await expect(saved).toBeChecked();
	await expect(restart.getByLabel("Skip releases")).toHaveCount(0);
	for (const width of [390, 1280, 1440]) {
		await page.setViewportSize({width,height:800});
		await expect(saved).toBeVisible();
		await page.screenshot({ path: info.outputPath(`saved-tls-${width}.png`) });
		await expect(restart.getByText("Saved options disable source TLS certificate verification.")).toBeVisible();
		expect(await restart.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
	}
	await saved.focus();
	await page.keyboard.press("Space");
	await expect(restart.getByRole("button", { name: "Dry Run" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await restart.getByRole("button", { name: "Production" }).click();
	await expect(
		restart.getByText("Source repository will be locked during migration and archived after success."),
	).toBeVisible();
	await restart.getByLabel("Repository Visibility").selectOption("private");
	await restart.getByLabel("Skip releases").check();
	await restart.getByLabel("Direct transfer").check();
	await restart.getByLabel("Skip SSL verification").check();
	await restart.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(restart).not.toBeVisible();
	const batchHydrated = page.waitForRequest(request => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate/batches/seed-restart-batch");
	await batchHydrated;
	await page.getByRole("button", {name: "Restart 1 Failed", exact:true}).click();
	const batch = page.getByRole("dialog", {name: "Restart Failed Migrations"});
	for (const width of [390,1280]) {
		await page.setViewportSize({width,height:800});
		await expect(batch.getByText("Saved options disable source TLS certificate verification for one or more migrations.")).toBeVisible();
		expect(await batch.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
		await page.screenshot({path: info.outputPath(`batch-saved-tls-${width}.png`)});
	}
});
test("an administrator can review an unsupported route without enabling restart", async ({ page }, info) => {
	const endpoint = "**/api/migrate/seed-e2e-unsupported-review/confirm-restart";
	const phrase = "target-review/legacy-" + "repository".repeat(7);
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate/seed-e2e-unsupported-review");
	await hydrated;

	const reviewButton = page.getByRole("button", { name: "Review remote status" });
	const restart = page.getByRole("button", { name: "Restart", exact: true });
	await expect(restart).toHaveCount(0);
	await reviewButton.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Review remote migration status" });
	const input = dialog.getByRole("textbox");
	const submit = dialog.getByRole("button", { name: "Confirm remote status" });
	await expect(dialog).toContainText("Restart remains unavailable for this route.");
	await expect(submit).toBeDisabled();
	await input.fill(phrase.toUpperCase());
	await expect(submit).toBeDisabled();
	await input.fill(phrase);
	await expect(submit).toBeEnabled();
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 844 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
		await page.screenshot({ path: info.outputPath(`unsupported-review-${width}.png`) });
	}
	await page.route(endpoint, (route) => route.fulfill({
		status: 409, json: { error: "Migration changed. Check the destination again." },
	}), { times: 1 });
	await submit.press("Enter");
	await expect(dialog.getByRole("alert")).toHaveText("Migration changed. Check the destination again.");
	await submit.press("Enter");
	await expect(dialog).toHaveCount(0);
	await expect(reviewButton).toHaveCount(0);
	await page.reload();
	await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
	await expect(reviewButton).toHaveCount(0);
	await expect(restart).toHaveCount(0);
});
