import { expect, test } from "@playwright/test";

test("statistics controls preserve the other filters and reset together", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate/stats?source=gitlab&target=ghes");
	await hydrated;
	const filters = page.getByRole("form", { name: "Statistics filters" });

	await filters.getByText("30 days", { exact: true }).click();
	await expect(page).toHaveURL(/source=gitlab&target=ghes&period=30d&mode=all$/);
	await filters.getByText("Batch", { exact: true }).click();
	await expect(page).toHaveURL(/source=gitlab&target=ghes&period=30d&mode=batch$/);
	await expect(filters.getByRole("radio", { name: "30 days" })).toBeChecked();
	await expect(filters.getByRole("radio", { name: "Batch", exact: true })).toBeChecked();

	await filters.getByRole("button", { name: /^Source/ }).click();
	await filters.getByRole("link", { name: "Bitbucket Server", exact: true }).click();
	await expect(page).toHaveURL(/source=bitbucket-server&target=ghes&period=30d&mode=batch$/);
	await expect(page.getByText("No migrations match these filters.", { exact: true })).toBeVisible();
	await expect(filters.getByRole("link", { name: "Reset filters" })).toHaveCount(0);

	await page.getByRole("link", { name: "Reset filters" }).click();
	await expect(page).toHaveURL(/\/migrate\/stats$/);
	await expect(filters.getByRole("radio", { name: "All time" })).toBeChecked();
	await expect(filters.getByRole("radio", { name: "All modes" })).toBeChecked();
});

test("statistics controls stay aligned and readable from mobile to wide desktop", async ({ page }) => {
	await page.goto("/migrate/stats?source=bitbucket-server&target=ghec");
	const filters = page.getByRole("form", { name: "Statistics filters" });

	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 991, height: 900 },
		{ width: 992, height: 900 },
		{ width: 1024, height: 900 },
		{ width: 1440, height: 1000 },
		{ width: 1920, height: 1080 },
	]) {
		await page.setViewportSize(viewport);
		const layout = await filters.evaluate((form) => ({
			overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
			heights: [...form.querySelectorAll(".filter-trigger, .stats-segmented")].map(
				(control) => control.getBoundingClientRect().height,
			),
			backgrounds: [...form.querySelectorAll(".filter-trigger, .stats-segmented")].map(
				(control) => getComputedStyle(control).backgroundColor,
			),
			columns: getComputedStyle(form).gridTemplateColumns.split(" ").length,
			controlsOutsideForm: [...form.children].some(
				(control) => control.getBoundingClientRect().right > form.getBoundingClientRect().right + 0.5,
			),
			clippedLabels: [...form.querySelectorAll(".stats-segment, [id$='-value']")].filter(
				(label) => label.scrollWidth > label.clientWidth,
			).length,
		}));
		expect(layout.overflow, `${viewport.width}px page overflow`).toBe(false);
		expect(layout.controlsOutsideForm, `${viewport.width}px controls outside form`).toBe(false);
		expect(layout.heights, `${viewport.width}px aligned controls`).toEqual([32, 32, 32, 32]);
		expect(new Set(layout.backgrounds).size, `${viewport.width}px consistent surfaces`).toBe(1);
		expect(layout.columns, `${viewport.width}px columns`).toBe(
			viewport.width < 640 ? 1 : viewport.width < 992 ? 2 : 4,
		);
		expect(layout.clippedLabels, `${viewport.width}px clipped labels`).toBe(0);
	}
});
