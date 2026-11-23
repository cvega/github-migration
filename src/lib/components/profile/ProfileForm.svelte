<script lang="ts">
	import { goto, invalidateAll } from "$app/navigation";
	import { getSourceProviderAdapter, SOURCE_PROVIDERS, type SourceProvider } from "$lib/source-provider";
	import SourceDiscovery from "./SourceDiscovery.svelte";

	let { providerAuthAvailable, sourceOrgs, bitbucketProjectKeys }: {
		providerAuthAvailable: Record<SourceProvider, boolean>; sourceOrgs: string[]; bitbucketProjectKeys: string[]
	} = $props();
	let dialog: HTMLDialogElement;
	let provider = $state<SourceProvider>("github");
	let scope = $state("enterprise");
	let target = $state("");
	let busy = $state(false);
	let error = $state("");
	let notice = $state("");
	let queue = $state("");
	const unit = $derived(provider === "bitbucket-server" ? "project" : provider === "github" ? "organization" : "group");
	const choices = $derived(provider === "github" ? sourceOrgs : provider === "bitbucket-server" ? bitbucketProjectKeys : []);
	let requestNumber = 0;
	async function readQueue() {
		const n = ++requestNumber;
		queue = "";
		if (!providerAuthAvailable[provider]) return;
		try {
			const res = await fetch(`/api/profile/queue?provider=${provider}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (n === requestNumber) queue = `${data.pending} waiting · ${data.failed} failed to start`;
		} catch (cause) {
			if (n === requestNumber) queue = `Queue status unavailable: ${cause instanceof Error ? cause.message : "request failed"}`;
		}
	}
	function open() {
		provider = SOURCE_PROVIDERS.find(p => providerAuthAvailable[p]) ?? "github";
		scope = "enterprise"; target = error = notice = "";
		dialog.showModal();
		void readQueue();
	}
	async function start(e: SubmitEvent) {
		e.preventDefault();
		if (busy || !providerAuthAvailable[provider]) return;
		busy = true; error = "";
		const enterprise = scope === "enterprise";
		try {
			const response = await fetch(enterprise ? "/api/profile/queue" : "/api/profile", {
				method:"POST", headers:{"content-type":"application/json"},
				body:JSON.stringify(enterprise ? {sourceProvider:provider, scope, enterprise:target.trim()} : {sourceProvider:provider,org:target.trim()})
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
			if (enterprise) {
				notice = `${data.added} queued from ${data.discovered} eligible namespaces.`;
				dialog.close();
				await invalidateAll();
			} else await goto(`/profile/${data.id}`);
		} catch (cause) { error = cause instanceof Error ? cause.message : "Could not start profiling."; }
		finally { busy = false; }
	}
</script>
<button type="button" class="primary" onclick={open}>New profile</button>
{#if notice}<p role="status" class="mt-1 text-sm text-gray-300">{notice}</p>{/if}
<dialog bind:this={dialog} aria-labelledby="new-profile-title" oncancel={e=>{if(busy)e.preventDefault();}} class="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-xl border border-gray-600 bg-gray-950 p-5 text-left text-gray-100 shadow-xl backdrop:bg-black/70">
	<h2 id="new-profile-title" class="text-lg font-semibold">New profile</h2>
	<form onsubmit={start} class="mt-4 space-y-4">
		<fieldset disabled={busy} class="space-y-4">
			<label class="block font-semibold">Source connection
				<select bind:value={provider} onchange={()=>{target=error="";void readQueue();}} class="control">
					{#each SOURCE_PROVIDERS as p (p)}<option value={p}>{p === "bitbucket-server" ? "Bitbucket Data Center" : getSourceProviderAdapter(p).displayName}{providerAuthAvailable[p] ? "" : " · Setup required"}</option>{/each}
				</select>
			</label>
			{#if providerAuthAvailable[provider]}
				<fieldset><legend class="mb-2 font-semibold">Profile scope</legend><div class="flex flex-wrap gap-4">
					<label><input type="radio" bind:group={scope} value="enterprise" onchange={()=>{target=error="";}} /> Entire enterprise</label>
					<label><input type="radio" bind:group={scope} value="one" onchange={()=>{target=error="";}} /> One {unit}</label>
				</div></fieldset>
				{#if scope === "one"}
					<label class="block font-semibold">{getSourceProviderAdapter(provider).namespaceLabel}
						<input bind:value={target} list="profile-suggestions" required class="control" />
					</label>
					<datalist id="profile-suggestions">{#each choices as key (key)}<option value={key}></option>{/each}</datalist>
					{#key provider}<SourceDiscovery {provider} onselect={key=>{ target=key;error=""; }} />{/key}
				{:else}
					{#if provider !== "bitbucket-server"}<label class="block font-semibold">{provider === "github" ? "GitHub enterprise slug" : "Enterprise group (required on GitLab.com)"}
						<input bind:value={target} required={provider === "github"} class="control" /></label>{/if}
					<p class="text-sm text-gray-400">Profiles all eligible namespaces, including previously completed profiles. No migrations are started.</p>
					{#if queue}<p class="text-sm text-gray-400">{queue} · <button type="button" class="text-blue-400" onclick={readQueue}>Refresh queue</button></p>{/if}
				{/if}
			{:else}<p class="text-sm text-amber-400">Configure this source in <a href="/setup" class="underline">Setup</a> before profiling.</p>{/if}
		</fieldset>
		{#if error}<p role="alert" class="text-sm text-red-400">{error}</p>{/if}
		<div class="flex justify-end gap-2 border-t border-gray-700 pt-4">
			<button type="button" disabled={busy} onclick={()=>dialog.close()} class="rounded-md border border-gray-600 px-3 py-1">Cancel</button>
			<button type="submit" disabled={busy || !providerAuthAvailable[provider]} class="primary">{busy ? "Starting…" : "Start profile"}</button>
		</div>
	</form>
</dialog>
<style>
	.primary{background:var(--button-primary-bgColor-rest,#238636);color:white;padding:5px 13px;border-radius:6px;font-weight:600;white-space:nowrap;font-size:14px}.primary:disabled{opacity:.5}
	.control{display:block;width:100%;background:var(--bgColor-default,#0d1117);border:1px solid var(--borderColor-default,#3d444d);border-radius:6px;margin-top:5px;padding:6px 10px;color:inherit;font-weight:400}
</style>
