import { expect, test } from "@playwright/test";

test("searches migrations from the application header", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate");
	await hydrated;

	const header = page.getByRole("banner");
	const search = header.getByRole("searchbox", { name: "Search migrations" });
	await expect(search).toBeVisible();
	const controlHeights = await Promise.all([
		header
			.getByRole("search", { name: "Migration search" })
			.evaluate((element) => element.getBoundingClientRect().height),
		header
			.getByRole("button", { name: /^Notifications/ })
			.evaluate((element) => element.getBoundingClientRect().height),
		header
			.locator('summary[aria-label^="Open user menu"]')
			.evaluate((element) => element.getBoundingClientRect().height),
	]);
	expect(controlHeights).toEqual([32, 32, 32]);
	await page.keyboard.press("/");
	await expect(search).toBeFocused();
	await search.fill("repository-one");

	await expect(page).toHaveURL(/\/migrate\?q=repository-one$/);
	await expect(page.getByRole("heading", { name: "Matching batches (1)" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Repositories (1)" })).toBeVisible();
	await expect(page.getByText("source-one/repository-one", { exact: true })).toBeVisible();
	await expect(search).toBeFocused();

	const rehydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.reload();
	await rehydrated;
	await expect(header.getByRole("searchbox", { name: "Search migrations" })).toHaveValue(
		"repository-one",
	);
	await header.getByRole("button", { name: "Clear migration search" }).click();
	await expect(page).toHaveURL(/\/migrate$/);
	await expect(header.getByRole("searchbox", { name: "Search migrations" })).toHaveValue("");
	await expect(search).toBeFocused();
});

test("opens list details from row content while preserving nested controls", async ({ page }) => {
	let hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate");
	await hydrated;
	await expect(page.getByRole("link", { name: /Finished/ })).toHaveAttribute("href", "#finished");

	const batchMetadata = page.getByText("1 succeeded", { exact: true }).first();
	const batchMetadataBox = await batchMetadata.boundingBox();
	expect(batchMetadataBox).not.toBeNull();
	await page.mouse.click(
		batchMetadataBox!.x + batchMetadataBox!.width / 2,
		batchMetadataBox!.y + batchMetadataBox!.height / 2,
	);
	await expect(page).toHaveURL(/\/migrate\/batches\/seed-e2e-batch-one$/);
	await expect(page.getByRole("progressbar", { name: "Batch progress" })).toHaveAttribute(
		"aria-valuenow",
		"100",
	);

	await page.goto("/migrate#finished");
	const migrationRow = page.locator("#finished > div > .group").first();
	await migrationRow.scrollIntoViewIfNeeded();
	const migrationRowBox = await migrationRow.boundingBox();
	expect(migrationRowBox).not.toBeNull();
	await page.mouse.click(
		migrationRowBox!.x + migrationRowBox!.width * 0.65,
		migrationRowBox!.y + migrationRowBox!.height / 2,
	);
	await expect(page).toHaveURL(/\/migrate\/seed-e2e-migration-one$/);

	hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate#finished");
	await hydrated;
	await page.getByRole("button", { name: "Batch" }).first().click();
	await expect(page).toHaveURL(/\/migrate\/batches\/seed-e2e-batch-one$/);

	hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate#finished");
	await hydrated;
	const listUrl = page.url();
	await page.getByRole("button", { name: "Copy error details" }).first().click();
	expect(page.url()).toBe(listUrl);
});

test("renders terminal migration detail with canonical provider links", async ({ page }) => {
	const browserErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning") {
			browserErrors.push(`${message.type()}: ${message.text()}`);
		}
	});
	page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

	await page.goto("/migrate/seed-e2e-ghes-detail");

	await expect(
		page.getByRole("heading", {
			name: "platform/services/widget to e2e-target/widget",
		}),
	).toBeAttached();
	await expect(page.getByRole("link", { name: "platform/services/widget" })).toHaveAttribute(
		"href",
		"https://gitlab.example.com/platform/services/widget",
	);
	await expect(page.getByRole("link", { name: "e2e-target/widget" })).toHaveAttribute(
		"href",
		"https://target.ghes.example.com/e2e-target/widget",
	);
	await expect(page.getByRole("region", { name: "Migration pipeline" })).toContainText(
		"6 of 6 complete",
	);
	await expect(page.getByRole("heading", { name: "Resource Verification" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Event Log" })).toBeVisible();
	await expect(page.getByText("No events recorded")).toBeVisible();

	const events = await page.request.get("/api/migrate/seed-e2e-ghes-detail/events");
	expect(events.ok()).toBe(true);
	expect(await events.text()).toContain('"type":"done","state":"succeeded"');

	await page.setViewportSize({ width: 390, height: 844 });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
		),
	).toBe(true);
	expect(browserErrors).toEqual([]);
});

test("opens active migration cancellation confirmation without changing state", async ({ page }) => {
	const eventStream = page.waitForRequest(
		(request) => request.url().endsWith("/api/migrate/seed-e2e-ghe-active/events"),
	);
	await page.goto("/migrate/seed-e2e-ghe-active");
	await eventStream;

	await expect(page.getByText("Starting", { exact: true })).toBeVisible();
	await expect(page.getByText("Waiting for events...")).toBeVisible();
	await page.getByRole("button", { name: "Cancel migration" }).click();

	const dialog = page.getByRole("dialog", { name: "Cancel this migration?" });
	await expect(dialog).toBeVisible();
	const submit = dialog.getByRole("button", { name: "Cancel Migration" });
	await expect(submit).toBeDisabled();
	await dialog.getByLabel(/Type tenant\/live-repo to confirm/).fill("tenant/live-repo");
	await expect(submit).toBeEnabled();
	await dialog.getByRole("button", { name: "Keep running" }).click();
	await expect(dialog).not.toBeVisible();

	const migration = await page.request.get("/api/migrate/seed-e2e-ghe-active");
	expect((await migration.json()).state).toBe("pending");
});