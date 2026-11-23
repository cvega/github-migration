<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";

	let { data } = $props();
</script>

<svelte:head><title>GitHub Migration Toolkit</title></svelte:head>

<div class="py-6">
	<div class="mb-10 text-center">
		<h1 class="text-2xl font-semibold text-gray-50">Profile, plan, and migrate</h1>
		<p class="mx-auto mt-2 max-w-xl text-sm text-gray-400">
			Begin with source readiness, turn the results into an approved plan, then move
			repositories to their migration destination.
		</p>
	</div>

	<div class="mx-auto grid max-w-3xl gap-5 sm:grid-cols-2">
		<a
			href="/profile"
			class="group relative flex flex-col rounded-lg border border-gray-700 bg-gray-900 p-6 transition-all hover:border-green-600/60 hover:bg-gray-800"
		>
			<div class="mb-4 flex items-start justify-between">
				<div class="flex h-11 w-11 items-center justify-center rounded-lg bg-green-600/15 text-green-400">
					<Octicon name="telescope" size={24} />
				</div>
				<span class="text-xs font-medium text-gray-500">Step 1</span>
			</div>
			<h2 class="text-lg font-semibold text-gray-50">Profile and plan</h2>
			<p class="mt-1.5 flex-1 text-sm text-gray-400">
				Profile a source organization, resolve migration findings, and approve a repository plan.
			</p>
			<div class="mt-4 flex items-center justify-end text-sm">
				<span class="inline-flex items-center gap-1 font-medium text-green-400">
					Start here
					<Octicon
						name="arrow-right"
						size={16}
						class="transition-transform group-hover:translate-x-0.5"
					/>
				</span>
			</div>
		</a>

		<a
			href="/migrate"
			class="group relative flex flex-col rounded-lg border border-gray-700 bg-gray-900 p-6 transition-all hover:border-green-600/60 hover:bg-gray-800"
		>
			<div class="mb-4 flex items-start justify-between">
				<div class="flex h-11 w-11 items-center justify-center rounded-lg bg-green-600/15 text-green-400">
					<Octicon name="repo-push" size={24} />
				</div>
				<span class="text-xs font-medium text-gray-500">Step 2</span>
			</div>
			<h2 class="text-lg font-semibold text-gray-50">Migrate</h2>
			<p class="mt-1.5 flex-1 text-sm text-gray-400">
				Launch approved plans or run direct migrations with live progress and crash-safe recovery.
			</p>
			<div class="mt-4 flex items-center justify-between text-sm">
				<span class="text-gray-500">
					{(data.activeMigrations ?? 0) > 0 ? `${data.activeMigrations} active` : "Ready"}
				</span>
				<span class="inline-flex items-center gap-1 font-medium text-green-400">
					Open
					<Octicon
						name="arrow-right"
						size={16}
						class="transition-transform group-hover:translate-x-0.5"
					/>
				</span>
			</div>
		</a>
	</div>
</div>