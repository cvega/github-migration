<script lang="ts">
	import { activeAppTab, visibleAppTabs } from "$lib/app-navigation";
	import type { AuthUser } from "$lib/auth-user";
	import NotificationBell from "$lib/components/NotificationBell.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { ActivityItem } from "$lib/migrate/types";

	let {
		pathname,
		setupComplete = false,
		recentActivity = [],
		authEnabled = false,
		currentUser = null,
	}: {
		pathname: string;
		setupComplete?: boolean;
		recentActivity?: ActivityItem[];
		authEnabled?: boolean;
		currentUser?: AuthUser | null;
	} = $props();

	const inMigrate = $derived(pathname.startsWith("/migrate"));
	const activeTab = $derived(activeAppTab(pathname));
	const tabs = $derived(visibleAppTabs(pathname, setupComplete));
</script>

<header class="border-b border-gray-700 bg-gray-900">
	<div class="flex min-h-16 items-center gap-2 px-3 py-2 sm:gap-3 sm:px-6">
		<a
			href="/"
			class="flex min-w-0 shrink items-center gap-2 rounded-md px-1 py-1.5 text-gray-50 outline-none transition-colors hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-blue-400"
		>
			<Octicon name="mark-github" size={24} class="shrink-0" />
			<span class="truncate text-sm font-semibold sm:text-base">Migration Toolkit</span>
		</a>
		<div class="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
			{#if activeTab === "profile"}
				<a
					href="/profile#start-profile"
					aria-label="Start profile"
					title="Start profile"
					class="flex h-9 items-center justify-center gap-1.5 rounded-md border border-green-500 bg-green-600 px-2.5 text-sm font-medium text-white outline-none transition-colors hover:bg-green-500 focus-visible:ring-2 focus-visible:ring-green-300 sm:px-3"
				>
					<Octicon name="telescope" size={16} />
					<span class="hidden sm:inline">Start profile</span>
				</a>
			{/if}
			{#if inMigrate}
				<NotificationBell initial={recentActivity} />
				<a
					href="/migrate/new"
					aria-label="New Migration"
					title="New Migration"
					class="flex h-9 items-center justify-center gap-1.5 rounded-md border border-green-500 bg-green-600 px-2.5 text-sm font-medium text-white outline-none transition-colors hover:bg-green-500 focus-visible:ring-2 focus-visible:ring-green-300 sm:px-3"
				>
					<Octicon name="repo-push" size={16} />
					<span class="hidden sm:inline">New migration</span>
				</a>
			{/if}
			{#if authEnabled && currentUser}
				<details class="group relative">
					<summary class="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-gray-700 px-2.5 text-sm text-gray-300 outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-400">
						<Octicon name={currentUser.role === "admin" ? "shield" : "people"} size={16} />
						<span class="hidden max-w-32 truncate sm:inline">{currentUser.displayName ?? currentUser.username}</span>
					</summary>
					<div class="absolute right-0 z-30 mt-2 w-52 overflow-hidden rounded-md border border-gray-700 bg-gray-900 py-1 shadow-xl">
						<div class="border-b border-gray-700 px-3 py-2"><p class="truncate text-sm font-medium text-gray-200">{currentUser.displayName ?? currentUser.username}</p><p class="truncate text-xs text-gray-500">{currentUser.username} / {currentUser.role === "admin" ? "Administrator" : "Operator"}</p></div>
						<a href="/account/password" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"><Octicon name="key" size={16} />Change password</a>
						{#if currentUser.role === "admin"}<a href="/admin/users" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"><Octicon name="people" size={16} />Manage users</a>{/if}
						{#if currentUser.role === "admin"}<a href="/admin/audit" class="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"><Octicon name="shield" size={16} />Audit log</a>{/if}
						<form method="POST" action="/logout"><button type="submit" class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-800"><Octicon name="sign-out" size={16} />Sign out</button></form>
					</div>
				</details>
			{/if}
		</div>
	</div>

	<nav aria-label="Primary" class="overflow-x-auto px-2 sm:px-4">
		<div class="flex min-w-max items-end gap-1">
			{#each tabs as tab (tab.id)}
				{@const selected = tab.id === activeTab}
				{@const setupAttention = tab.id === "setup" && !setupComplete && !selected}
				<a
					href={tab.href}
					aria-current={selected ? "page" : undefined}
					class="inline-flex h-12 shrink-0 items-center gap-2 border-b-2 px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 sm:px-3 {selected
						? 'border-(--underlineNav-borderColor-active) font-semibold text-gray-50'
						: setupAttention
							? 'border-transparent text-yellow-300 hover:bg-yellow-500/10 hover:text-yellow-200'
							: 'border-transparent text-gray-400 hover:bg-gray-800/60 hover:text-gray-200'}"
				>
					<Octicon name={tab.icon} size={16} class="hidden sm:inline-block" />
					{tab.label}
				</a>
			{/each}
		</div>
	</nav>
</header>