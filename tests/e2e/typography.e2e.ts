import { expect, test, type Page } from "@playwright/test";

const routes = [
  "/styleguide",
  "/migrate",
  "/migrate/stats",
  "/setup",
  "/profile/seed-e2e-profile",
];

async function undersizedVisibleText(page: Page) {
  return page.evaluate(() =>
    [...document.body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const hasDirectText = [...element.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        return hasDirectText && style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      })
      .filter((element) => Number.parseFloat(getComputedStyle(element).fontSize) < 13)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim().slice(0, 80),
        size: getComputedStyle(element).fontSize,
      })),
  );
}

test("applies the typography system across representative routes", async ({ page }, testInfo) => {
  for (const route of routes) {
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);

    expect(await undersizedVisibleText(page), `${route} has undersized text`).toEqual([]);
    expect(
      await page.evaluate(() => getComputedStyle(document.body).fontFamily),
      `${route} uses the interface font`,
    ).toContain("Mona Sans");
    if (route === "/migrate/stats") {
      await page.screenshot({ path: testInfo.outputPath("migration-stats-desktop.png"), fullPage: true });
    }
  }

  await page.goto("/setup");
  const machineText = page.locator(".text-machine").first();
  await expect(machineText).toBeVisible();
  await expect(machineText).toHaveCSS("font-family", /Mona Sans Mono/);
  await expect(machineText).toHaveCSS("font-size", "14px");
  await expect(machineText).toHaveCSS("line-height", "20px");
  expect(
    await page.evaluate(() => ({
      interfaceLoaded: document.fonts.check("16px Mona Sans"),
      machineLoaded: document.fonts.check("14px Mona Sans Mono"),
    })),
  ).toEqual({ interfaceLoaded: true, machineLoaded: true });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of routes) {
    await page.goto(route);
    expect(await undersizedVisibleText(page), `${route} has undersized mobile text`).toEqual([]);
    if (route === "/migrate/stats") {
      await page.screenshot({ path: testInfo.outputPath("migration-stats-mobile.png"), fullPage: true });
    }
  }
});