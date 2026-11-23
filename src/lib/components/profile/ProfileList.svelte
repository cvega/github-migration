<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { timeAgo } from "$lib/format";
	import type { NumericObservation } from "$lib/source/types";
	import type { SourceProvider } from "$lib/source-provider";

	type ProfileRunListItem = {
		id: string; sourceProvider: SourceProvider; org: string; state: "running" | "failed" | "completed";
		totalRepos: number; profiledRepos: number; blockers: number; warnings: number; startedAt: string;
		inventoryProjectCount: NumericObservation | null; failureReason?: string | null;
		metrics?: Partial<Record<"commits" | "pullRequests" | "branches", NumericObservation>>;
	};
	let {runs,totalRuns,search="",onSearch,assigned=false}:{runs:ProfileRunListItem[];totalRuns:number;search?:string;onSearch?:(q:string)=>void;assigned?:boolean}=$props();
	let query=$derived(search);
	const sources={
		"bitbucket-server":{name:"Bitbucket Data Center",icon:"bitbucket-logo",color:"bg-blue-500/15 text-blue-400"},
		github:{name:"GitHub",icon:"mark-github",color:"bg-gray-800 text-gray-200"},
		gitlab:{name:"GitLab",icon:"gitlab-logo",color:"bg-orange-500/10 text-orange-400"}
	} as const;
	const badges={completed:{icon:"check-circle-fill",text:"Completed",color:"text-green-400"},failed:{icon:"x-circle-fill",text:"Failed",color:"text-red-400"},running:{icon:"sync",text:"Running",color:"text-blue-400"}} as const;
	const terms=$derived(query.trim().toLowerCase().split(/\s+/));
	const visible=$derived(onSearch ? runs : runs.filter(r=>terms.every(t=>`${r.org} ${sources[r.sourceProvider].name} ${r.sourceProvider}`.toLowerCase().includes(t))));
	function value(n:NumericObservation|undefined){
		if(!n || n.kind==="unavailable")return "Unavailable";
		return `${n.kind==="at-least"?"At least ":""}${n.value.toLocaleString()}`;
	}
	function count(r:ProfileRunListItem){
		if(r.sourceProvider==="github")return r.state==="failed"?"Profile incomplete":`${r.profiledRepos}/${r.totalRepos} repos`;
		const n=r.inventoryProjectCount;
		if(!n || n.kind==="unavailable")return r.state==="running"?"Discovering repositories":"Inventory unavailable";
		return `${value(n)} ${r.sourceProvider==="gitlab"?(n.value===1?"project":"projects"):(n.value===1?"repository":"repositories")}`;
	}
</script>
<section class="overflow-hidden rounded-md border border-gray-700" aria-labelledby="recent-title">
	<div class="flex flex-wrap items-center justify-between gap-2 bg-gray-900 px-4 py-2.5">
		<h2 id="recent-title" class="flex items-center gap-2 text-sm font-semibold"><Octicon name="history" size={16} class="text-gray-400"/>Recent profiles <span aria-live="polite" class="rounded-full bg-gray-800 px-2 font-medium">{onSearch?totalRuns:visible.length}</span></h2>
		<label class="flex h-8 w-full items-center gap-2 rounded-md border border-gray-600 bg-gray-950 px-2 focus-within:ring-2 focus-within:ring-blue-400 sm:w-60">
			<Octicon name="search" size={16} class="text-gray-400"/><input type="search" aria-label="Search profiles by project or source" placeholder="Search profiles…" maxlength="100" bind:value={query} oninput={e=>onSearch?.(e.currentTarget.value)} class="min-w-0 flex-1 bg-transparent text-sm outline-none"/>
		</label>
	</div>
	{#each visible as run (run.id)}
		{@const provider=sources[run.sourceProvider]}
		{@const badge=badges[run.state]}
		<details class="border-t border-gray-700">
			<summary class="row cursor-pointer hover:bg-gray-900">
				<span class="mark rounded-lg {provider.color}"><Octicon name={provider.icon} size={24}/></span>
				<span class="min-w-0"><strong class="block truncate text-base font-semibold">{run.org}</strong><small class="text-gray-400">{provider.name} · {count(run)}</small></span>
				<span class="status flex items-center gap-1.5 text-gray-400"><Octicon name={badge.icon} size={16} class={badge.color}/>{badge.text}</span>
				<time datetime={run.startedAt} title="Started {run.startedAt}" class="when text-gray-400">{timeAgo(run.startedAt)}</time>
				<Octicon name="chevron-right" size={16} class="arrow hidden text-gray-400 sm:block"/>
			</summary>
			<div class="flex flex-wrap items-center gap-x-5 gap-y-2 bg-gray-900 px-4 py-3 text-sm sm:pl-[4.5rem]">
				{#if run.state==="failed"}<span>{run.failureReason ?? "Profile incomplete"}</span>
				{:else if run.metrics}{#each ["commits","pullRequests","branches"] as key (key)}
					{@const metric=key==="commits"?run.metrics.commits:key==="pullRequests"?run.metrics.pullRequests:run.metrics.branches}
					{#if metric}<span>{value(metric)} {key==="commits"?"default-branch commits":key==="pullRequests"?"pull requests":"branches"}</span>{/if}
				{/each}
				{:else if run.sourceProvider==="github"}<span>{run.blockers} blockers · {run.warnings} warnings</span>{/if}
				<a href="/profile/{run.id}" class="text-blue-400 hover:underline">View full profile<span class="sr-only"> for {run.org}</span></a>
			</div>
		</details>
	{:else}
		<p class="border-t border-gray-700 px-4 py-8 text-center text-gray-400">{query.trim()?"No matching profiles. Try a different project or source.":assigned?"No completed profiles are assigned to you.":"No profiles yet. Choose New profile to get started."}</p>
	{/each}
</section>
<style>
	.row{display:grid;grid-template-columns:38px minmax(0,1fr) 7.5rem 6rem 14px;align-items:center;gap:14px;padding:14px 18px;font-size:13px}.row::-webkit-details-marker{display:none}.mark{display:grid;place-items:center;height:38px}.when{text-align:right}.row small{font-size:13px}details[open] :global(.arrow){transform:rotate(90deg)}
	@media(max-width:639px){.row{grid-template-columns:32px minmax(0,1fr) auto;gap:2px 9px;padding:12px}.mark{height:32px}.mark,.row>span:nth-child(2){grid-row:span 2}.status,.when{grid-column:3;justify-self:end}.status{grid-row:1}.when{grid-row:2}}
</style>
