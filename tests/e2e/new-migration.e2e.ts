import { expect, test } from "@playwright/test";

for (const mode of ["single", "batch"] as const) {
	test(`${mode} migration distinguishes destination writes from source handling`, async ({ page }) => {
		const posts: { path: string; body: unknown }[] = [];
		await page.route("**/api/migrate**", (route) => {
			const request = route.request();
			if (request.method() !== "POST") return route.continue();
			posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
			return route.fulfill({ status: 409, json: { error: "Fixture intercepted launch" } });
		});
		const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
		await page.goto("/migrate/new");
		await hydrated;
		await page.getByText("GitHub", { exact: true }).click();
		await page.getByRole("button", { name: /GitHub Enterprise Cloud/ }).click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		if (mode === "batch") {
			await page.getByRole("button", { name: "Batch", exact: true }).click();
			await page.getByLabel(/Repository list/).fill("api\nweb");
		} else {
			await page.getByLabel(/Repository name/).fill("api");
		}
		await page.getByRole("button", { name: "Continue to source access" }).click();
		await page.getByLabel("Personal access token", { exact: true }).fill("fixture-source");
		await page.getByRole("button", { name: "Continue to target" }).click();
		await page.getByLabel("Personal access token", { exact: true }).fill("fixture-target");
		await page.getByRole("button", { name: "Continue to options" }).click();

		const unlocked = page.getByRole("button", { name: /Keep source unlocked.*Do not lock or archive/ });
		const lock = page.getByRole("button", { name: /Lock and archive source.*Archive after success/ });
		const writes = page.getByText("Both choices write repository data to the destination.");
		const form = page.locator("form").filter({ has: writes });
		await expect(writes).toBeVisible();
		await expect(form).not.toContainText(/dry[- ]run/i);
		await expect(unlocked).toHaveAttribute("aria-pressed", "true");
		await lock.click();
		await page.getByRole("button", { name: "Continue to readiness" }).click();
		await expect(writes).toBeVisible();
		await expect(form).not.toContainText(/dry[- ]run/i);
		await expect(lock).toHaveAttribute("aria-pressed", "true");

		const launch = page.getByRole("button", { name: mode === "batch" ? "Start batch migration" : "Start migration", exact: true });
		await launch.click();
		const dialog = page.getByRole("dialog", { name: "Confirm source lock and archive" });
		await expect(dialog).toContainText("write repository data to the destination");
		await expect(dialog).toContainText("archived as read-only after its migration succeeds");
		expect(posts).toHaveLength(0);
		await dialog.getByRole("button", { name: "Confirm and start" }).click();
		await expect(dialog.getByRole("alert")).toHaveText("Fixture intercepted launch");
		await dialog.getByRole("button", { name: "Go back" }).click();
		await unlocked.click();
		await launch.click();
		await expect(page.getByRole("alert")).toHaveText("Fixture intercepted launch");
		const path = mode === "batch" ? "/api/migrate/batches" : "/api/migrate";
		expect(posts).toMatchObject([
			{ path, body: { lockSource: true, archiveSource: true } },
			{ path, body: { lockSource: false, archiveSource: false } },
		]);
	});
}
