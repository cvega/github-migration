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

	for (const width of [1146, 1440, 390]) {
		await page.setViewportSize({ width, height: 900 });
		const pipeline = await page.getByRole("heading", { name: "Migration pipeline" }).boundingBox();
		const log = await page.getByRole("heading", { name: "Event log" }).boundingBox();
		const logRegion = await page.getByRole("region", { name: "Event log" }).boundingBox();
		const verification = await page.getByRole("region", { name: "Target repository contents" }).boundingBox();
		expect(verification?.x).toBe(logRegion?.x);
		expect(verification?.width).toBe(logRegion?.width);
		if (!pipeline || !log) throw new Error("Missing migration detail heading");
		if (width >= 1024) expect(Math.abs(log.y - pipeline.y)).toBeLessThanOrEqual(2);
		else expect(log.y).toBeGreaterThan(pipeline.y + pipeline.height);
	}

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
	await expect(page.getByRole("heading", { name: "Target repository contents" })).toBeVisible();
	const resources = page.getByRole("region", { name: "Target repository contents" });
	await expect(resources).toContainText("target resource totals have not been collected");
	await expect(resources.locator("dd")).toHaveCount(0);
	await expect(resources.getByRole("button", { name: "Fetch counts" })).toBeVisible();
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

test("reports count-fetch failures without changing a successful migration", async ({ page }) => {
	await page.goto("/migrate/seed-e2e-ghes-detail");
	const resources = page.getByRole("region", { name: "Target repository contents" });
	await resources.getByRole("button", { name: "Fetch counts" }).click();
	await expect(resources.getByRole("alert")).toContainText("Could not fetch target resource counts");
	await expect(resources.locator("dd")).toHaveCount(0);
	await expect(resources.getByRole("button", { name: "Fetch counts" })).toBeEnabled();
	const migration = await page.request.get("/api/migrate/seed-e2e-ghes-detail");
	expect(await migration.json()).toMatchObject({ state: "succeeded", targetCounts: null, elapsedSeconds: 90 });
});

test("GHES export events stay in the log rather than adding pipeline stages", async ({ page }) => {
	await page.goto("/migrate/seed-e2e-bitbucket-failed");
	const pipeline = page.getByRole("region", { name: "Migration pipeline" });
	const steps = pipeline.getByRole("listitem");
	await expect(steps).toHaveCount(6);
	await expect(pipeline).not.toContainText("Starting Bitbucket Server export");
	await expect(page.getByRole("region", { name: "Event log" })).toContainText("Starting Bitbucket Server export");
	const time = page.getByRole("region", { name: "Event log" }).locator("time").first();
	for (const width of [390, 1146]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await time.evaluate((element) => {
			const text = document.createRange();
			text.selectNodeContents(element);
			return text.getClientRects().length;
		})).toBe(1);
		const unusedHeight = await time.evaluate(element => {
			const box = element.parentElement!.parentElement!;
			return box.getBoundingClientRect().bottom - box.lastElementChild!.getBoundingClientRect().bottom;
		});
		expect(unusedHeight).toBeLessThanOrEqual(1);
	}
});

test("shows recorded counts instead of unverified completion snapshots, including real zeros", async ({ page }) => {
	const response = await page.request.get("/api/migrate/seed-e2e-migration-two");
	const migration = await response.json();
	let targetCounts = { commits: 1204816, branches: 184, tags: 2408, issues: 128904, pullRequests: 106372, releases: 0 };
	await page.route("**/api/migrate/seed-e2e-migration-two", (route) =>
		route.fulfill({ json: { ...migration, targetCounts } }),
	);

	await page.goto("/migrate/seed-e2e-migration-two");
	const resources = page.getByRole("region", { name: "Target repository contents" });
	await expect(resources.locator("dd")).toHaveText(["1,204,816", "184", "2,408", "128,904", "106,372", "0"], { timeout: 10_000 });
	await expect(resources.locator('dt > svg[aria-hidden="true"]')).toHaveCount(6);
	for (const width of [1146, 390, 320]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await resources.locator("dd").evaluateAll(values => {
			const boxes = values.map(el => el.getBoundingClientRect());
			return boxes.every((box, i) => box.right === boxes[0]?.right && box.top >= (boxes[i - 1]?.bottom ?? -Infinity));
		})).toBe(true);
		expect(await resources.locator("dd").evaluateAll(values => values.every(el => el.scrollWidth <= el.clientWidth))).toBe(true);
	}
	await expect(resources.getByRole("button", { name: "Fetch counts" })).toHaveCount(0);
	await expect(resources).toContainText("Commits count the default branch only.");

	targetCounts = { commits: 0, branches: 0, tags: 0, issues: 0, pullRequests: 0, releases: 0 };
	await page.reload();
	await expect(resources.locator("dd")).toHaveText(["0", "0", "0", "0", "0", "0"], { timeout: 10_000 });
	await expect(resources.getByRole("button", { name: "Fetch counts" })).toHaveCount(0);
});

test("opens active migration cancellation confirmation without changing state", async ({ page }) => {
	const eventStream = page.waitForRequest(
		(request) => request.url().endsWith("/api/migrate/seed-e2e-ghe-active/events?after=0"),
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

test("a streamed native step advances the shared rail before completion", async ({ page }) => {
	const id = "seed-e2e-ghe-active";
	await page.route(`**/api/migrate/${id}/events*`, route => route.fulfill({
		contentType: "text/event-stream",
		body: `id: 1\ndata: ${JSON.stringify({ id: 1, migrationId: id, eventType: "step", phase: "EXPORTING", payload: { executorPhase: "exporting", message: "Starting Bitbucket Server export" }, createdAt: "2026-11-21T23:57:49Z" })}\n\n`,
	}));
	await page.goto(`/migrate/${id}`);
	const rail = page.getByRole("region", { name: "Migration pipeline" });
	await expect(rail.getByRole("listitem").filter({ hasText: "Exporting" })).toContainText("In progress");
	await expect(page.getByRole("region", { name: "Event log" })).toContainText("Starting Bitbucket Server export");
});

test("GHES preparation after archive ready is not an active export or import", async ({ page }) => {
	const id = "seed-e2e-ghe-active";
	const steps = [
		["EXPORTING", "archive_ready", "Archive ready"],
		[null, "transferring", "Transferring archive to GHES with SCP"],
		[null, "preparing", "Preparing archive on GHES"],
	];
	await page.route(`**/api/migrate/${id}/events*`, route => route.fulfill({
		contentType: "text/event-stream",
		body: steps.map(([phase, executorPhase, message], i) => `id: ${i + 1}\ndata: ${JSON.stringify({
			id: i + 1, migrationId: id, eventType: "step", phase, payload: { executorPhase, message }, createdAt: "2026-11-21T23:57:49Z",
		})}\n\n`).join(""),
	}));
	await page.goto(`/migrate/${id}`);
	const rail = page.getByRole("region", { name: "Migration pipeline" });
	await expect(rail).toContainText("Preparing archive on GHES");
	await expect(rail.getByRole("listitem").filter({ hasText: "Exporting" })).toContainText("Complete");
	await expect(rail.getByRole("listitem").filter({ hasText: "Git Import" })).toContainText("Not started");
});