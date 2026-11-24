import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("admin and operator use the same report and migration pages, with disjoint scope enforced", async ({ browser, page: admin }, info) => {
  const suffix = randomBytes(4).toString("hex").toUpperCase();
  const password = randomBytes(16).toString("hex");
  const fixture = fileURLToPath(new URL("./fixtures/portal-users.ts", import.meta.url));
  execFileSync("bun", [fixture, suffix], { env: {
    ...process.env, BITBUCKET_SERVER_URL: "https://bitbucket.invalid",
    BITBUCKET_SERVER_PROJECT_KEYS: "", GH_TARGET_ORG: "test-target-org", PORTAL_TEST_PASSWORD: password,
  } });
  const report = `/profile/portal-a-${suffix}`;
  await admin.goto(report);
  const heading = await admin.getByRole("heading", { level: 1 }).innerText();
  await admin.screenshot({ path: info.outputPath("admin-profile.png") });
  for (const tag of ["a", "b"]) {
    const context = await browser.newContext({ storageState: undefined });
    try {
      const page = await context.newPage();
      const own = `portal-${tag}-${suffix}`;
      const other = `portal-${tag === "a" ? "b" : "a"}-${suffix}`;
      const ownProject = `PORTAL${tag.toUpperCase()}${suffix}`;
      await page.goto("/login");
      await page.getByLabel("Username").fill(own);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("heading", { name: "Profile, plan, and migrate" })).toBeVisible();
      const nav = page.getByRole("navigation", { name: "Primary" });
      await nav.getByRole("link", { name: /^Profile/ }).click();
      await expect(page.getByRole("heading", { name: "Source profiles" })).toBeVisible();
      await expect(page.locator("main")).toContainText(ownProject);
      expect((await page.goto(`/profile/${own}`))?.status()).toBe(200);
      await expect(page.locator("main")).toContainText(`private-${tag}`);
      const plan = page.getByRole("region", { name: "Build migration plan" });
      const destination = plan.getByRole("definition");
      await expect(plan.getByText("Assigned destination", { exact: true })).toBeVisible();
      await expect(destination).toContainText("test-target-org");
      await expect(destination).toContainText("GitHub Enterprise Cloud");
      await expect(plan.getByRole("combobox")).toHaveCount(0);
      const launch = plan.getByRole("button", { name: "Launch batch" });
      if (tag === "a") {
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
        await page.screenshot({ path: info.outputPath("operator-profile.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        const exportPlan = plan.getByRole("button", { name: "Export" });
        const exportBox = await exportPlan.boundingBox();
        const launchBox = await launch.boundingBox();
        if (!exportBox || !launchBox) throw new Error("Expected both plan actions to be visible");
        expect(await destination.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThan(exportBox.y);
        expect(launchBox.x).toBeGreaterThanOrEqual(exportBox.x + exportBox.width);
        expect(launchBox.y).toBeLessThan(exportBox.y + exportBox.height);
        await expect(launch).toBeDisabled();
        await plan.getByRole("checkbox", { name: `Select ${ownProject}/private-a` }).check();
        await expect(launch).toBeEnabled();
      } else {
        await expect(destination).toContainText("Read only");
        await expect(launch).toHaveCount(0);
      }
      await nav.getByRole("link", { name: /^Migrations/ }).click();
      await expect(page.getByRole("heading", { name: "Migrations", exact: true })).toBeVisible();
      await expect(page.locator("main")).toContainText(`private-${tag}`);
      await expect(page.locator("main")).not.toContainText(`private-${tag === "a" ? "b" : "a"}`);
      expect((await page.goto(`/migrate/${own}`))?.status()).toBe(200);
      for (const path of [`/profile/${other}`, `/migrate/${other}`, `/admin/users`, `/api/migrate/events`])
        expect((await context.request.get(path)).status(), path).toBe(404);
    } finally { await context.close(); }
  }
});
