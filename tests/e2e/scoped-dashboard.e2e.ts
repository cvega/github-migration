import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, type Locator, test } from "@playwright/test";

// The scenarios seed the same disposable SQLite database.
test.describe.configure({ mode: "default" });

function seedOperators() {
  const suffix = randomBytes(4).toString("hex").toUpperCase();
  const password = randomBytes(16).toString("hex");
  const fixture = fileURLToPath(new URL("./fixtures/portal-users.ts", import.meta.url));
  execFileSync("bun", [fixture, suffix], { env: {
    ...process.env, BITBUCKET_SERVER_URL: "https://bitbucket.invalid",
    BITBUCKET_SERVER_PROJECT_KEYS: "", GH_TARGET_ORG: "test-target-org", PORTAL_TEST_PASSWORD: password,
  } });
  return {suffix,password};
}

async function chooseSource(access: Locator, namespace: string) {
  const choices = access.getByRole("navigation", { name: "Choose a source" });
  if (!(await choices.isVisible())) await access.getByLabel(/^Choose a source:/).press("Enter");
  await choices.getByRole("link", { name: `${namespace} (Bitbucket Server)` }).click();
  await expect(access.getByRole("group", { name: `GitHub destinations for ${namespace}` })).toBeVisible();
}

test("admin and operator use the same report and migration pages, with disjoint scope enforced", async ({ browser, page: admin }, info) => {
  const {suffix,password} = seedOperators();
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
      for (const path of [`/profile/${other}`, `/migrate/${other}`, `/admin/users`, `/admin/targets`, `/api/migrate/events`])
        expect((await context.request.get(path)).status(), path).toBe(404);
    } finally { await context.close(); }
  }
});

test("admin assigns destination sets per source; an operator switches sources without carrying a route or selection across", async ({browser,page:admin},info) => {
  const {suffix,password} = seedOperators();
  const operator = `portal-a-${suffix}`;
  const a = `PORTALA${suffix}`;
  const b = `PORTALB${suffix}`;
  await admin.goto(`/admin/users?q=${operator}`);
  await admin.getByRole("link",{name:`Manage ${operator}`}).click();
  const access = admin.getByRole("region",{name:"Migration access"});
  await chooseSource(access, a);
  await expect(access.getByRole("link",{name:`View report for ${a}`})).toHaveAttribute("href",`/profile/${operator}`);
  const destinations = access.getByRole("group",{name:`GitHub destinations for ${a}`});
  const assigned = destinations.getByRole("listitem").filter({hasText:"test-target-org"});
  await expect(access.getByText("test-target-org",{exact:true})).toHaveCount(1);
  await expect(assigned.getByRole("checkbox")).toHaveCount(0);
  await expect(assigned.getByRole("button",{name:/^Remove/})).toBeVisible();
  await expect(assigned).toContainText("View and migrate");
  await expect(access.getByRole("button",{name:"Assign destinations"})).toBeDisabled();
  for (const width of [971,1440,390]) {
    await admin.setViewportSize({width,height:844});
    expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const section = await access.boundingBox();
    const list = await destinations.boundingBox();
    if (!section || !list) throw new Error("Expected destination list");
    expect(list.width).toBeGreaterThan(section.width * 0.85);
    await access.screenshot({path:info.outputPath(`admin-routes-${width}.png`)});
  }
  await access.getByRole("checkbox",{name:"Cloud alternate-org",exact:true}).check();
  await access.getByRole("checkbox",{name:"Cloud archive-org",exact:true}).check();
  await expect(access.getByText("2 selected",{exact:true})).toBeVisible();
  await access.getByRole("button",{name:"Assign destinations"}).click();
  await expect(admin.getByRole("status")).toHaveText("Assigned 2 destinations.");
  await expect(access.getByText("All available destinations are assigned for this source.")).toBeVisible();
  await chooseSource(access, b);
  const bDestinations = access.getByRole("group",{name:`GitHub destinations for ${b}`});
  const secondSourceTarget = bDestinations.getByRole("checkbox",{name:"Cloud alternate-org",exact:true});
  await secondSourceTarget.check();
  await expect(secondSourceTarget).toBeChecked();
  await access.getByLabel("Permission for new destinations").selectOption("migrate");
  await access.getByRole("button",{name:"Assign destinations"}).click();
  await expect(admin.getByRole("status")).toHaveText("Assigned 1 destination.");
  await access.screenshot({path:info.outputPath("admin-routes.png")});

  const context = await browser.newContext({storageState:undefined});
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Username").fill(operator);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button",{name:"Sign in"}).click();
    await expect(page.getByRole("heading",{name:"Profile, plan, and migrate"})).toBeVisible();
    await page.goto(`/profile/${operator}`);
    const plan = page.getByRole("region",{name:"Build migration plan"});
    const target = plan.getByRole("combobox",{name:"Assigned destination"});
    await expect(target).toHaveValue("");
    await expect(target).toBeEnabled();
    const launch = plan.getByRole("button",{name:"Launch batch"});
    await plan.getByRole("checkbox",{name:`Select ${a}/private-a`}).check();
    await expect(plan.getByText("1 selected",{exact:true})).toBeVisible();
    await expect(launch).toBeDisabled();
    await target.selectOption({label:"GHEC · alternate-org · Read only"});
    await expect(launch).toHaveCount(0);
    await target.selectOption({label:"GHEC · test-target-org"});
    await expect(launch).toBeEnabled();
    for (const width of [1440,1093,390]) {
      await page.setViewportSize({width,height:844});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await plan.screenshot({path:info.outputPath(`operator-routes-${width}.png`)});
    }
    const switcher = page.getByText("Switch source",{exact:true});
    await switcher.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("navigation",{name:"Assigned sources"}).getByRole("link",{name:`${b} · Bitbucket Server`}).click();
    await expect(page).toHaveURL(new RegExp(`/profile/portal-b-${suffix}$`));
    await expect(plan.getByRole("combobox")).toHaveCount(0);
    await expect(plan.getByRole("definition")).toContainText("alternate-org");
    await expect(plan.getByRole("checkbox",{name:`Select ${b}/private-b`})).not.toBeChecked();
    await expect(plan).not.toContainText("test-target-org");
  } finally {
    await context.close();
  }
});

test("admin can assign and remove routes without JavaScript, even after the operator is disabled", async ({browser,page:admin}) => {
  const {suffix} = seedOperators();
  const username = `portal-a-${suffix}`;
  const b = `PORTALB${suffix}`;
  const context = await browser.newContext({javaScriptEnabled:false,storageState:await admin.context().storageState()});
  try {
    const page = await context.newPage();
    await page.goto(`/admin/users?q=${username}`);
    await page.getByRole("link",{name:`Manage ${username}`}).click();
    const access = page.getByRole("region",{name:"Migration access"});
    await chooseSource(access, b);
    await access.getByRole("button",{name:"Assign destinations"}).click();
    await expect(page.getByRole("alert")).toContainText("Choose a source and one or more distinct destinations");
    await access.getByRole("checkbox",{name:"Cloud alternate-org",exact:true}).check();
    await access.getByRole("button",{name:"Assign destinations"}).click();
    await expect(page.getByRole("status")).toHaveText("Assigned 1 destination.");
    const row = access.getByRole("group",{name:`GitHub destinations for ${b}`}).getByRole("listitem").filter({hasText:"alternate-org"});
    await expect(row).toContainText("View only");
    await row.getByRole("button",{name:/^Remove/}).click();
    await expect(access.getByRole("checkbox",{name:"Cloud alternate-org",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Disable user"}).click();
    await expect(access).toContainText("Only active operators can receive route assignments");
    await access.getByRole("button",{name:`Remove PORTALA${suffix} (bitbucket-server) to test-target-org (ghec)`}).click();
    await expect(page.getByRole("status")).toHaveText("Profile access removed.");
    await expect(access.getByRole("button",{name:/^Remove/})).toHaveCount(0);
  } finally { await context.close(); }
});

test("admin maintains a target list independently, then maps a filtered provider source", async ({ page }) => {
  const {suffix} = seedOperators();
  const user = `portal-a-${suffix}`, source = `PORTALA${suffix}`, org = `landing-${suffix.toLowerCase()}`;
  await page.goto(`/admin/users?q=${user}`);
  await page.getByRole("link",{name:`Manage ${user}`}).click();
  const userPage = page.url();
  await page.getByRole("link",{name:"Manage targets"}).click();
  const cloud = page.getByRole("region",{name:"Cloud target organizations"});
  const editor = page.getByRole("region",{name:"Add target"});
  await expect(editor).toHaveCount(0);
  await page.getByRole("link",{name:"Add target",exact:true}).click();
  await editor.getByRole("button",{name:"Find organizations"}).click();
  await expect(page.getByRole("alert")).toContainText("Check target credentials");
  await editor.getByLabel("Organization login").fill(org);
  await editor.getByRole("button",{name:"Add target"}).click();
  await expect(page.getByRole("status")).toContainText("No user access was granted");
  await editor.getByRole("link",{name:"Close"}).click();
  await page.reload();
  const target = cloud.getByRole("listitem").filter({hasText:org});
  await expect(target).toContainText("Added by an admin");
  await expect(target).toContainText("View only");
  await page.goto(userPage);
  const access = page.getByRole("region",{name:"Migration access"});
  await access.getByLabel(/^Choose a source:/).click();
  await access.getByRole("searchbox",{name:"Filter profiled sources"}).fill(source);
  const nav = access.getByRole("navigation",{name:"Choose a source"});
  await expect(nav.getByRole("link")).toHaveCount(1);
  await nav.getByRole("link",{name:`${source} (Bitbucket Server)`}).click();
  const option = access.getByRole("checkbox",{name:`Cloud ${org}`});
  await expect(option).not.toBeChecked();
  await access.getByLabel("Permission for new destinations").selectOption("migrate");
  await option.check();
  const permission = access.getByLabel("Permission for new destinations");
  await expect(permission).toHaveValue("view");
  await expect(permission.getByRole("option",{name:"View and migrate"})).toBeDisabled();
  await access.getByRole("button",{name:"Assign destinations"}).click();
  await expect(page.getByRole("status")).toHaveText("Assigned 1 destination.");
  await access.getByRole("link",{name:"Manage targets"}).click();
  await cloud.getByRole("button",{name:`Remove ${org} from Cloud`}).click();
  await expect(page.getByRole("alert")).toContainText("Remove user mappings");
});

test("target directory works with native links and forms", async ({ browser, page: admin }) => {
  const org = `native-${crypto.randomUUID().slice(0,8)}`;
  const context = await browser.newContext({javaScriptEnabled:false,storageState:await admin.context().storageState()});
  try {
    const page = await context.newPage();
    await page.goto("/admin/targets");
    await page.getByText("Connection details",{exact:true}).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("GH_TARGET_ORG",{exact:true})).toBeVisible();
    await page.getByRole("link",{name:"Add target",exact:true}).click();
    const editor = page.getByRole("region",{name:"Add target"});
    await expect(editor.getByRole("link",{name:"Cloud"})).toHaveAttribute("aria-current","page");
    await editor.getByLabel("Organization login").fill(org);
    await editor.getByRole("button",{name:"Add target"}).click();
    await expect(page.getByRole("status")).toContainText("Target listed");
    await editor.getByRole("link",{name:"Close"}).click();
    const cloud = page.getByRole("region",{name:"Cloud target organizations"});
    await cloud.getByRole("button",{name:`Remove ${org} from Cloud`}).click();
    await expect(page.getByRole("status")).toContainText("Target removed");
    await expect(cloud.getByText(org,{exact:true})).toHaveCount(0);
  } finally { await context.close(); }
});
