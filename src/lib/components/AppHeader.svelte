<script lang="ts">
	import { toSvg } from "jdenticon";
	import { activeAppTab, visibleAppTabs } from "$lib/app-navigation";
	import type { AuthUser } from "$lib/auth-user";
	import MigrationSearch from "$lib/components/migrate/MigrationSearch.svelte";
	import NotificationBell from "$lib/components/NotificationBell.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { ActivityItem } from "$lib/migrate/types";

	let {
		pathname,
		setupComplete = false,
		profileCount = 0,
		migrationCount = 0,
		recentActivity = [],
		authEnabled = false,
		currentUser = null,
	}: {
		pathname: string;
		setupComplete?: boolean;
		profileCount?: number;
		migrationCount?: number;
		recentActivity?: ActivityItem[];
		authEnabled?: boolean;
		currentUser?: AuthUser | null;
	} = $props();

	const activeTab = $derived(activeAppTab(pathname));
	const operator = $derived(currentUser?.role === "operator");
	const tabs = $derived(visibleAppTabs(pathname, setupComplete).filter(tab =>
		!operator || tab.id === "profile" || tab.id === "migrations"));
	const showMigrationSearch = $derived(pathname === "/migrate");
	const accountName = $derived(currentUser?.displayName?.trim() || currentUser?.username || "User");
	const avatarUrl = $derived(
		`data:image/svg+xml,${encodeURIComponent(
			toSvg(currentUser?.username ?? "user", 100, {
				backColor: "#d0d7de",
				padding: 0.08,
			}),
		)}`,
	);
	const countFormatter = new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	});

	function revealActiveTab(selected: boolean) {
		return (node: HTMLElement) => {
			if (!selected) return;
			const frame = requestAnimationFrame(() => {
				node.scrollIntoView({ block: "nearest", inline: "center" });
			});
			return () => cancelAnimationFrame(frame);
		};
	}
</script>

<header class="border-b border-gray-700 bg-gray-900">
	<div class="flex min-h-16 flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-6">
		<a
			href="/"
			class="flex min-w-0 shrink items-center gap-2 rounded-md px-1 py-1.5 text-gray-50 outline-none transition-colors hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-blue-400"
		>
			<Octicon name="mark-github" size={24} class="shrink-0" />
			<span class="truncate text-sm font-semibold sm:text-base">Migration Toolkit</span>
		</a>
		<div class="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
			{#if showMigrationSearch}
				<div class="w-56 sm:w-64">
					<MigrationSearch />
				</div>
			{/if}
			{#if !operator}<NotificationBell initial={recentActivity} />{/if}
			{#if authEnabled && currentUser}
				<details class="group relative">
					<summary
						aria-label={`Open user menu for ${accountName}`}
						title={accountName}
						class="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full outline-none ring-1 ring-gray-600 transition-all hover:ring-gray-400 focus-visible:ring-2 focus-visible:ring-blue-400 group-open:ring-2 group-open:ring-blue-400"
					>
						<img src={avatarUrl} alt="" class="h-7.5 w-7.5 rounded-full" />
					</summary>
					<div class="absolute right-0 z-30 mt-2 w-52 overflow-hidden rounded-md border border-gray-700 bg-gray-900 py-1 shadow-xl">
						<div class="border-b border-gray-700 px-3 py-2"><p class="truncate text-sm font-medium text-gray-200">{accountName}</p><p class="truncate text-xs text-gray-500">{currentUser.username} / {currentUser.role === "admin" ? "Administrator" : "Operator"}</p></div>
						<a href="/account/password" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"><Octicon name="key" size={16} />Change password</a>
						{#if currentUser.role === "admin"}<a href="/admin/users" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"><Octicon name="people" size={16} />Manage users</a>{/if}
						{#if currentUser.role === "admin"}<a href="/admin/audit" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"><Octicon name="shield" size={16} />Audit log</a>{/if}
						<form method="POST" action="/logout"><button type="submit" class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-800"><Octicon name="sign-out" size={16} />Sign out</button></form>
					</div>
				</details>
			{/if}
		</div>
	</div>

	<nav
		aria-label="Primary"
		class="scrollbar-none overflow-x-auto px-2 sm:px-4"
	>
		<div class="flex min-w-max items-end gap-1">
			{#each tabs as tab (tab.id)}
				{@const selected = tab.id === activeTab}
				{@const setupAttention = tab.id === "setup" && !setupComplete && !selected}
				{@const count = tab.id === "profile" ? profileCount : tab.id === "migrations" ? migrationCount : null}
				<a
					href={tab.href}
					aria-current={selected ? "page" : undefined}
					{@attach revealActiveTab(selected)}
					class="inline-flex h-12 shrink-0 items-center gap-2 border-b-2 px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 sm:px-3 {selected
						? 'border-(--underlineNav-borderColor-active) font-semibold text-gray-50'
						: setupAttention
							? 'border-transparent text-yellow-300 hover:bg-yellow-500/10 hover:text-yellow-200'
							: 'border-transparent text-gray-400 hover:bg-gray-800/60 hover:text-gray-200'}"
				>
					<span class="hidden sm:inline-flex"><Octicon name={tab.icon} size={16} /></span>
					{tab.label}
					{#if count !== null}
						<span class="min-w-5 rounded-full bg-gray-800 px-1.5 py-0.5 text-center text-xs font-medium leading-4 tabular-nums text-gray-300">
							{countFormatter.format(count)}
						</span>
					{/if}
				</a>
			{/each}
		</div>
	</nav>
</header>