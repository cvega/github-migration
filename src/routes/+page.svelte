<!-- Workspace landing page — choose between the Migrate and Profile workspaces. -->
<script lang="ts">
	import Octicon from '$lib/components/Octicon.svelte';

	let { data } = $props();
</script>

<svelte:head><title>GitHub Migration Toolkit</title></svelte:head>

<div class="py-6">
	<div class="mb-10 text-center">
		<h1 class="text-2xl font-semibold text-gray-50">Choose a workspace</h1>
		<p class="mx-auto mt-2 max-w-xl text-sm text-gray-400">
			Plan and run GitHub migrations end to end — profile a source for readiness,
			then move repositories to GitHub Enterprise Cloud.
		</p>
	</div>

	<div class="mx-auto grid max-w-3xl gap-5 sm:grid-cols-2">
		<!-- Migrate (active) -->
		<a
			href="/migrate"
			class="group relative flex flex-col rounded-lg border border-gray-700 bg-gray-900 p-6 transition-all hover:border-green-600/60 hover:bg-gray-800"
		>
			<div class="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-green-600/15 text-green-400">
				<Octicon name="arrow-switch" size={24} />
			</div>
			<h2 class="text-lg font-semibold text-gray-50">Migrate</h2>
			<p class="mt-1.5 flex-1 text-sm text-gray-400">
				Move repositories from GHES or GHEC to GitHub Enterprise Cloud — in
				batches, with live progress and crash-safe recovery.
			</p>
			<div class="mt-4 flex items-center justify-between text-sm">
				<span class="text-gray-500">
					{#if data.activeMigrations > 0}
						<span class="text-blue-400">{data.activeMigrations}</span> active
					{:else}
						Ready
					{/if}
				</span>
				<span class="inline-flex items-center gap-1 font-medium text-green-400">
					Open
					<Octicon name="arrow-right" size={16} class="transition-transform group-hover:translate-x-0.5" />
				</span>
			</div>
		</a>

		<!-- Profile -->
		<a
			href="/profile"
			class="group relative flex flex-col rounded-lg border border-gray-700 bg-gray-900 p-6 transition-all hover:border-violet-600/60 hover:bg-gray-800"
		>
			<div class="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-violet-600/15 text-violet-400">
				<Octicon name="telescope" size={24} />
			</div>
			<h2 class="text-lg font-semibold text-gray-50">Profile</h2>
			<p class="mt-1.5 flex-1 text-sm text-gray-400">
				Analyze a source organization for migration readiness — surface what GEI
				won't carry cleanly and route each gap to its remediation.
			</p>
			<div class="mt-4 flex items-center justify-end text-sm">
				<span class="inline-flex items-center gap-1 font-medium text-violet-400">
					Open
					<Octicon name="arrow-right" size={16} class="transition-transform group-hover:translate-x-0.5" />
				</span>
			</div>
		</a>
	</div>
</div>
