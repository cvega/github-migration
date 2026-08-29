<script lang="ts">
	import { activeAppTab, visibleAppTabs } from "$lib/app-navigation";
	import NotificationBell from "$lib/components/NotificationBell.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { ActivityItem } from "$lib/migrate/types";

	let {
		pathname,
		setupComplete = false,
		recentActivity = [],
		authEnabled = false,
	}: {
		pathname: string;
		setupComplete?: boolean;
		recentActivity?: ActivityItem[];
		authEnabled?: boolean;
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
			{#if authEnabled}
				<form method="POST" action="/logout" class="m-0 flex">
					<button
						type="submit"
						class="flex h-9 w-9 items-center justify-center rounded-md border border-gray-700 bg-gray-900 text-gray-400 outline-none transition-colors hover:border-gray-600 hover:bg-gray-800 hover:text-gray-50 focus-visible:ring-2 focus-visible:ring-blue-400"
						title="Sign out"
						aria-label="Sign out"
					>
						<Octicon name="sign-out" size={16} />
					</button>
				</form>
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