import { expect, test } from "@playwright/test";

test("confirms ambiguous remote state before offering restart credentials", async ({ page }) => {
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
});