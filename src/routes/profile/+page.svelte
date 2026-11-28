<script lang="ts">
	import { goto } from "$app/navigation";
	import Pagination from "$lib/components/Pagination.svelte";
	import ProfileForm from "$lib/components/profile/ProfileForm.svelte";
	import ProfileList from "$lib/components/profile/ProfileList.svelte";

	let { data } = $props();
	function navigate(q:string,page:number,replaceState=false) {
		const params=new URLSearchParams();
		if(q.trim())params.set("q",q.trim());
		if(page>1)params.set("page",String(page));
		return goto(`/profile${params.size?`?${params}`:""}`,{reset:false,replaceState});
	}
</script>

<svelte:head><title>Profile - GitHub Migration Toolkit</title></svelte:head>

<div class="mx-auto max-w-5xl space-y-6">
	<header class="flex items-start justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold text-gray-50">Source profiles</h1>
			<p class="mt-1 text-sm text-gray-400">
				Repository inventory and activity, by source.
			</p>
		</div>
		{#if data.profileSetup}
			<div class="min-w-0 text-right"><ProfileForm {...data.profileSetup} /></div>
		{/if}
	</header>
	<div>
		<ProfileList runs={data.runs} totalRuns={data.pagination.total} search={data.q} onSearch={q=>navigate(q,1,true)} assigned={!data.profileSetup} />
		<Pagination {...data.pagination} onPageChange={page=>navigate(data.q,page)} />
	</div>
</div>