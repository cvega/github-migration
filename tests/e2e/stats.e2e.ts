import { expect, test } from "@playwright/test";

test("historical exporter trace is summarized and reachable at desktop and mobile widths", async ({page}) => {
	for (const width of [390,1280,1440]) {
		await page.setViewportSize({width,height:900});
		await page.goto("/migrate/stats");
		await expect(page.getByText("Commits reflect default-branch history.", {exact:true})).toBeVisible();
		const incident = page.locator("#attention :is(td,li):visible").filter({hasText:"Bitbucket exporter could not write the migration archive"});
		await expect(incident).toHaveCount(1);
		const link = incident.getByRole("link",{name:/Last failed run · \d{4}-\d{2}-\d{2}/});
		await expect(link).toHaveAttribute("href","/migrate/seed-e2e-bitbucket-failed");
		await expect(page.locator("#attention")).not.toContainText("rb_sysopen");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await page.locator("#attention a:visible[href='/migrate/seed-e2e-bitbucket-failed']").click();
	await page.getByText("Recorded failure", {exact:true}).click();
	await expect(page.locator("details[open]")).toContainText("Errno::EACCES");
});

test("statistics groups retain detailed data and path volume", async ({ page }) => {
	await page.goto("/migrate/stats");

	const sections = page.locator("section#overview, section#attention, section#performance");
	await expect(sections).toHaveCount(3);
	expect(await sections.evaluateAll((elements) => elements.map((element) => element.id))).toEqual([
		"overview",
		"attention",
		"performance",
	]);

	const overview = page.getByRole("region", { name: "Overview" });
	await expect(overview.getByRole("heading", { name: "Migration outcomes" })).toBeVisible();
	await expect(overview.getByText("Success rate compares succeeded and failed migrations; outcomes include all states.")).toHaveCount(1);
	const chartDay = overview.getByRole("button", { name: /succeeded, .*failed/ }).first();
	await expect(chartDay).toBeVisible();
	await chartDay.focus();
	await expect(chartDay.locator("span").first()).toBeVisible();
	const bar = chartDay.locator("div div").first();
	await expect(bar).toHaveCSS("border-radius", "0px");

	const attention = page.getByRole("region", { name: "Needs attention" });
	const failure = attention.getByRole("cell", { name: "Seeded native migration failure" }).first();
	await expect(failure).toBeVisible();
	expect(await failure.evaluate((cell) => getComputedStyle(cell).textOverflow)).not.toBe("ellipsis");

	const paths = attention.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Path" }) });
	await expect(paths.getByRole("columnheader", { name: "Volume" })).toBeVisible();
	const failureColor = await failure.evaluate((cell) => getComputedStyle(cell).color);
	const pathColor = await paths.locator("tbody tr td:first-child").first().evaluate((cell) => getComputedStyle(cell).color);
	expect(failureColor).toBe(pathColor);
	const pathCounts = await paths.locator("tbody tr").evaluateAll((rows) =>
		rows.map((row) => ({
			total: Number(row.children[1]?.textContent?.trim().replaceAll(",", "")),
			volume: Number(row.children[2]?.textContent?.trim().replace("%", "")),
		})),
	);
	expect(pathCounts.length).toBeGreaterThan(0);
	const total = pathCounts.reduce((sum, path) => sum + path.total, 0);
	for (const path of pathCounts) {
		expect(path.volume).toBe(Math.round((path.total / total) * 100));
	}

	const performance = page.getByRole("region", { name: "Performance & volume" });
	for (const name of ["Highlights", "Destination repository contents", "Top source organizations", "Per-migration averages"]) {
		await expect(performance.getByRole("heading", { name, exact: true })).toBeVisible();
	}
});

test("statistics controls preserve the other filters and reset together", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate/stats?source=gitlab&target=ghes");
	await hydrated;
	const filters = page.getByRole("form", { name: "Statistics filters" });

	await filters.getByText("30 days", { exact: true }).click();
	await expect(page).toHaveURL(/source=gitlab&target=ghes&period=30d&mode=all$/);
	await filters.getByText("Single", { exact: true }).click();
	await expect(page).toHaveURL(/source=gitlab&target=ghes&period=30d&mode=single$/);
	await expect(filters.getByRole("radio", { name: "30 days" })).toBeChecked();
	await expect(filters.getByRole("radio", { name: "Single", exact: true })).toBeChecked();

	await filters.getByRole("button", { name: /^Source/ }).click();
	await filters.getByRole("link", { name: "Bitbucket Server", exact: true }).click();
	await expect(page).toHaveURL(/source=bitbucket-server&target=ghes&period=30d&mode=single$/);
	await expect(page.getByText("No migrations match these filters.", { exact: true })).toBeVisible();
	await expect(filters.getByRole("link", { name: "Reset filters" })).toHaveCount(0);

	await page.getByRole("link", { name: "Reset filters" }).click();
	await expect(page).toHaveURL(/\/migrate\/stats$/);
	await expect(filters.getByRole("radio", { name: "All time" })).toBeChecked();
	await expect(filters.getByRole("radio", { name: "All modes" })).toBeChecked();
});

test("statistics PDF printing keeps filtered report data and full tables", async ({ page }) => {
	const hydrated = page.waitForRequest((request) => request.url().endsWith("/api/rate-limits"));
	await page.goto("/migrate/stats?source=gitlab&target=ghes&period=all&mode=all");
	await hydrated;
	await expect(page.getByRole("region", { name: "Report cover" })).toBeHidden();
	await expect(page.getByRole("region", { name: "Report closing page" })).toBeHidden();
	await page.evaluate(() => {
		window.print = () => document.body.setAttribute("data-print-requested", "true");
	});
	await page.getByRole("button", { name: "Print or save PDF" }).click();
	await expect(page.locator("body")).toHaveAttribute("data-print-requested", "true");

	await page.emulateMedia({ media: "print" });
	const cover = page.getByRole("region", { name: "Report cover" });
	await expect(cover).toBeVisible();
	await expect(cover.locator(".stats-cover-brand")).toContainText("GitHub");
	await expect(cover.locator(".stats-cover-brand svg")).toBeVisible();
	await expect(cover.getByText("GitLab", { exact: true })).toBeVisible();
	await expect(cover.getByText("GitHub Enterprise Server", { exact: true })).toBeVisible();
	await expect(cover.getByText("All time", { exact: true })).toBeVisible();
	await expect(cover.getByText("All modes", { exact: true })).toBeVisible();
	expect(await cover.evaluate((element) => getComputedStyle(element).breakAfter)).toBe("page");
	const closing = page.getByRole("region", { name: "Report closing page" });
	await expect(closing.getByRole("heading", { name: "End of report" })).toBeVisible();
	await expect(closing).toContainText("GitLab → GitHub Enterprise Server · All time · All modes");
	expect(await closing.evaluate((element) => getComputedStyle(element).breakBefore)).toBe("page");
	await expect(page.locator(".stats-print-context")).toContainText(
		"Source: GitLab · Target: GitHub Enterprise Server · Started: All time · Mode: All modes",
	);
	await expect(page.getByRole("form", { name: "Statistics filters" })).toBeHidden();
	await expect(page.locator("body > div header")).toBeHidden();
	await expect(page.locator(".stats-export")).toBeHidden();
	await expect(page.locator(".stats-compact-list:visible")).toHaveCount(0);
	const pathTable = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Path" }) });
	await expect(pathTable.getByRole("columnheader", { name: "Duration data" })).toBeVisible();
	const tableLayout = await pathTable.evaluate((table) => ({
		width: table.getBoundingClientRect().width,
		parentWidth: table.parentElement!.getBoundingClientRect().width,
		clippedCells: [...table.querySelectorAll("th, td")].filter(
			(cell) => cell.getBoundingClientRect().right > table.getBoundingClientRect().right + 1,
		).length,
	}));
	expect(tableLayout.width).toBeLessThanOrEqual(tableLayout.parentWidth + 1);
	expect(tableLayout.clippedCells).toBe(0);
	await expect(page.getByRole("heading", { name: "Performance by repository size" })).toBeVisible();
	const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
	expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
	expect(pdf.length).toBeGreaterThan(10_000);

	await page.goto("/migrate/stats");
	const failure = page.getByRole("cell", { name: "Seeded native migration failure" });
	await expect(failure).toBeVisible();
	expect(await failure.evaluate((cell) => getComputedStyle(cell).overflowWrap)).toBe("anywhere");
	await expect(page.getByRole("heading", { name: "Completions over time" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Per-migration averages" })).toBeVisible();
});

test("statistics PDF printing identifies empty filtered results", async ({ page }) => {
	await page.goto("/migrate/stats?source=bitbucket-server&target=ghes&period=30d&mode=single");
	await page.emulateMedia({ media: "print" });
	const cover = page.getByRole("region", { name: "Report cover" });
	await expect(cover.getByText("Bitbucket Server", { exact: true })).toBeVisible();
	await expect(cover.getByText("30 days", { exact: true })).toBeVisible();
	await expect(cover.getByText("Single", { exact: true })).toBeVisible();
	await expect(page.getByRole("region", { name: "Report closing page" }).getByRole("heading", { name: "End of report" })).toBeVisible();
	await expect(page.locator(".stats-print-context")).toContainText(
		"Source: Bitbucket Server · Target: GitHub Enterprise Server · Started: 30 days · Mode: Single",
	);
	await expect(page.getByText("No migrations match these filters.", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Reset filters" })).toBeHidden();
});

test("statistics distinguish unavailable size and final counts from zero", async ({ page }) => {
	await page.goto("/migrate/stats");
	const overview = page.getByRole("region", { name: "Overview" });
	const size = overview.locator("dt").filter({ hasText: "Source repository size" }).locator("..");
	await expect(size).toContainText("0 of");
	await expect(size.locator("dd")).toHaveText("—");
	const resources = page.getByRole("heading", { name: "Destination repository contents" }).locator("xpath=ancestor::section[1]");
	await expect(resources).toContainText("0 of");
	await expect(resources.locator("dt").filter({ hasText: "Commits" }).locator("..").locator("dd")).toHaveText("—");
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
