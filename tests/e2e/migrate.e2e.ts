import { expect, test } from "@playwright/test";

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