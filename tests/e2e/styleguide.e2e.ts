import { expect, test } from "@playwright/test";

test("renders and exercises the live Migration Workbench style guide", async ({ page }) => {
  await page.goto("/styleguide");

  await expect(page).toHaveTitle("Migration Workbench Style Guide");
  await expect(page.getByRole("heading", { level: 1, name: "Migration Workbench" })).toBeVisible();
  await expect(page.locator(".guide-section")).toHaveCount(3);
  await expect(page.locator(".guide-section").first()).toHaveAttribute("id", "components");
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        family: getComputedStyle(document.body).fontFamily,
        loaded: document.fonts.check("16px Mona Sans"),
      };
    }),
  ).toEqual({
    family: '"Mona Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    loaded: true,
  });

  const overview = page.getByRole("navigation", { name: "Reference overview" });
  await expect(overview.getByRole("link")).toHaveCount(5);
  await expect(overview.getByRole("link", { name: /Svelte components/ })).toHaveAttribute(
    "href",
    "#components",
  );
  await expect(overview.getByRole("link", { name: /Workflow stages/ })).toHaveAttribute(
    "href",
    "#composition",
  );
  await expect(overview.getByRole("link", { name: /Typography roles/ })).toHaveAttribute(
    "href",
    "#typography",
  );
  await expect(overview.getByRole("link", { name: /Shipped Octicons/ })).toHaveAttribute(
    "href",
    "#iconography",
  );
  await expect(overview.getByRole("link", { name: /Color roles/ })).toHaveAttribute(
    "href",
    "#foundations",
  );

  await expect(page.getByRole("heading", { level: 2, name: "Reference composition" })).toBeAttached();
  const sectionLayout = await page.evaluate(() => {
    const sections = [...document.querySelectorAll<HTMLElement>(".guide-section")];
    const headingLeftEdges = sections.map((section) =>
      Math.round(section.querySelector<HTMLElement>(":scope > header")?.getBoundingClientRect().left ?? 0),
    );
    return {
      aligned: new Set(headingLeftEdges).size === 1,
      hasSectionRules: sections.some(
        (section) => getComputedStyle(section).borderBottomWidth !== "0px",
      ),
    };
  });
  expect(sectionLayout).toEqual({ aligned: true, hasSectionRules: false });

  const mismatchedPrimerTokens = await page.evaluate(() => {
    const mappings = {
      "--workbench-canvas-inset": "--bgColor-inset",
      "--workbench-canvas": "--bgColor-default",
      "--workbench-surface": "--bgColor-muted",
      "--workbench-control-surface": "--control-bgColor-rest",
      "--workbench-control-hover": "--control-bgColor-hover",
      "--workbench-control-active": "--control-bgColor-active",
      "--workbench-rule-muted": "--borderColor-muted",
      "--workbench-rule": "--borderColor-default",
      "--workbench-rule-strong": "--borderColor-emphasis",
      "--workbench-path-muted": "--bgColor-accent-muted",
      "--workbench-path-emphasis": "--bgColor-accent-emphasis",
      "--workbench-ready-muted": "--bgColor-success-muted",
      "--workbench-ready-emphasis": "--button-primary-bgColor-rest",
      "--workbench-production-muted": "--bgColor-attention-muted",
      "--workbench-production-emphasis": "--bgColor-attention-emphasis",
      "--workbench-danger-muted": "--bgColor-danger-muted",
      "--workbench-danger-emphasis": "--bgColor-danger-emphasis",
    } as const;
    const style = getComputedStyle(document.documentElement);
    return Object.entries(mappings)
      .filter(([workbenchToken, primerToken]) => {
        const workbenchValue = style.getPropertyValue(workbenchToken).trim();
        const primerValue = style.getPropertyValue(primerToken).trim();
        return workbenchValue !== primerValue;
      })
      .map(([workbenchToken]) => workbenchToken);
  });
  expect(mismatchedPrimerTokens).toEqual([]);

  const components = page.locator("#components");
  await expect(
    components.getByRole("heading", { level: 2, name: "Fourteen components, doing the real work" }),
  ).toBeAttached();
  await expect(components.locator(".registry-groups li")).toHaveCount(18);
  await expect(components.locator('[aria-label="Migration pipeline"]')).toHaveCount(1);
  await expect(components.locator(".showcase-module")).toHaveCount(13);
  await expect(components.locator(".atlas-tally strong")).toHaveText("14");

  const iconography = components.locator("#iconography");
  await expect(
    iconography.getByRole("heading", { level: 4, name: "Octicons in the workbench" }),
  ).toBeVisible();
  const shippedIconCount = Number(await iconography.getAttribute("data-icon-count"));
  expect(shippedIconCount).toBeGreaterThan(50);
  await expect(iconography.locator(".icon-inventory-grid > div")).toHaveCount(shippedIconCount);
  await expect(iconography.locator(".icon-size-scale svg")).toHaveCount(3);
  await expect(iconography.locator(".icon-size-scale svg").evaluateAll((icons) =>
    icons.map((icon) => icon.getAttribute("width")),
  )).resolves.toEqual(["12", "16", "24"]);
  await expect(iconography.locator(".provider-icon-list")).toContainText("Octicons");
  await expect(iconography.locator(".provider-icon-list")).toContainText("Simple Icons");

  const providerSpecimen = components.locator(".provider-showcase");
  await providerSpecimen.getByRole("radio", { name: "GitLab" }).evaluate((radio) => {
    (radio as HTMLInputElement).click();
  });
  await expect(providerSpecimen.locator(".specimen-state code")).toHaveText("gitlab");

  await components.getByRole("button", { name: "GitHub App" }).click();
  await expect(components.getByLabel("App ID")).toBeVisible();

  await components.getByRole("button", { name: "Open destructive confirmation" }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete migration record" });
  await expect(confirmation).toBeVisible();
  const deleteButton = confirmation.getByRole("button", { name: "Delete record" });
  await expect(deleteButton).toBeDisabled();
  await confirmation.getByLabel(/Type delete migration to confirm/).fill("delete migration");
  await expect(deleteButton).toBeEnabled();
  await confirmation.getByRole("button", { name: "Close" }).click();

  const paginationSpecimen = components.locator(".pagination-stage");
  await paginationSpecimen.getByRole("button", { name: "Next" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(paginationSpecimen.locator('[aria-current="page"]')).toHaveText("5");

  const composition = page.locator("#composition");
  await composition.getByRole("tab", { name: "Review" }).click();
  await composition.getByRole("button", { name: "Mobile" }).click();
  await composition.getByRole("button", { name: "Production", exact: true }).click();

  await expect(composition.locator(".workflow-preview")).toHaveClass(/compact/);
  await expect(composition.getByText("6 of 6", { exact: true })).toBeVisible();
  await expect(composition.getByRole("button", { name: "Start production migration" })).toBeVisible();

  const geometry = await composition.locator(".workflow-preview").evaluate((preview) => ({
    width: Math.round(preview.getBoundingClientRect().width),
    overflows: preview.scrollWidth > preview.clientWidth,
  }));
  expect(geometry).toEqual({ width: 390, overflows: false });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
});