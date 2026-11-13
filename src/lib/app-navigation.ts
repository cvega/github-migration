import type { UsedIconName } from "$lib/icons.generated";

export type AppTabId = "profile" | "migrations" | "statistics" | "mannequins" | "setup";

export type AppTab = {
  id: AppTabId;
  label: string;
  href: string;
  icon: UsedIconName;
};

const APP_TABS = [
  { id: "profile", label: "Profile", href: "/profile", icon: "telescope" },
  { id: "migrations", label: "Migrations", href: "/migrate", icon: "repo-push" },
  { id: "statistics", label: "Statistics", href: "/migrate/stats", icon: "graph" },
  { id: "mannequins", label: "Mannequins", href: "/mannequins", icon: "people" },
  { id: "setup", label: "Setup", href: "/setup", icon: "gear" },
] as const satisfies readonly AppTab[];

function matchesPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function activeAppTab(pathname: string): AppTabId | null {
  if (matchesPath(pathname, "/migrate/stats")) return "statistics";
  if (matchesPath(pathname, "/migrate")) return "migrations";
  if (matchesPath(pathname, "/profile")) return "profile";
  if (matchesPath(pathname, "/mannequins")) return "mannequins";
  if (matchesPath(pathname, "/setup")) return "setup";
  return null;
}

export function visibleAppTabs(_pathname: string, _setupComplete: boolean): readonly AppTab[] {
  return APP_TABS;
}
