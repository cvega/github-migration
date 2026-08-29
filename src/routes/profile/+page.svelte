<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import ProfileForm from "$lib/components/profile/ProfileForm.svelte";
	import ProfileList from "$lib/components/profile/ProfileList.svelte";

	let { data } = $props();
</script>

<svelte:head><title>Profile - GitHub Migration Toolkit</title></svelte:head>

<div class="space-y-8">
	<header class="flex items-center justify-between gap-4">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50">
				<Octicon name="telescope" size={24} class="text-green-400" />
				Profile
			</h1>
			<p class="mt-1 text-sm text-gray-400">
				Profile a source namespace to surface migration scope, coverage, and risks.
			</p>
		</div>
		<a href="/" class="shrink-0 text-sm text-gray-400 transition-colors hover:text-gray-50">Workspaces</a>
	</header>

	<ProfileForm
		providerAuthAvailable={data.providerAuthAvailable}
		sourceOrgs={data.sourceOrgs}
		bitbucketProjectKeys={data.bitbucketProjectKeys}
	/>
	<ProfileList runs={data.runs} totalRuns={data.totalRuns} />
</div>