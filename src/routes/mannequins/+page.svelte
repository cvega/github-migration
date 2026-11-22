<script lang="ts">
	import { enhance } from "$app/forms";

	let { data, form } = $props();
	let teams = $state(false);
	let editor = $state<"manual" | "csv" | null>(null);
	let selection = $state("");
	let source = $state("");
	let busy = $state(false);
	const kind = $derived(teams ? "team" : "user");
	const options = $derived(data.scopes.filter(s => !teams || s.platform === "ghes"));
	const key = (s: {target: string; organization: string}) => `${s.target}/${s.organization}`;
	const scope = $derived(options.find(s => key(s) === selection) ?? options.find(s => s.target === data.target.id && s.organization === data.organization) ?? options[0]);
	const sources = $derived([
		...(scope?.platform === "ghes" ? [
			[`ghe-migrator:bitbucket-server${teams ? ":team" : ""}`, "Bitbucket Server URL"],
			[`ghe-migrator:gitlab${teams ? ":team" : ""}`, "GitLab URL"],
		] : []),
		...(!teams ? [["mannequin-login", "Mannequin login"], ["mannequin-id", "Mannequin node ID"]] : []),
	]);
	const sourceKind = $derived(sources.some(([id]) => id === source) ? source : sources[0]?.[0]);
	const rows = $derived(data.identityMappings.filter(m => m.sourceKind.endsWith(":team") === teams));
	const attributionScopes = $derived(data.scopes.filter(s => data.identityMappings.some(m =>
		m.targetId === s.target && m.targetOrg === s.organization && m.sourceKind.startsWith("mannequin-"))));
	const submit: NonNullable<Parameters<typeof enhance>[1]> = () => {
		busy = true;
		return async ({ result, update }) => {
			try { await update(); if (result.type === "success") editor = null; }
			finally { busy = false; }
		};
	};
</script>

<svelte:head><title>Mappings - GitHub Migration Toolkit</title></svelte:head>
<div class="mx-auto max-w-5xl space-y-5">
	<header><h1 class="text-2xl font-semibold text-gray-50">Mappings</h1>
		<p class="mt-1 text-sm text-gray-400">Match source users and teams to GitHub identities across repositories.</p></header>
	<fieldset class="flex gap-2 border-b border-gray-700"><legend class="sr-only">Mapping type</legend>
		{#each [false, true] as isTeam (isTeam)}
			<button type="button" aria-pressed={teams === isTeam} onclick={() => {teams = isTeam; editor = null;}}
				class="border-b-2 px-3 py-2 text-sm font-medium {teams === isTeam ? 'border-orange-400 text-gray-50' : 'border-transparent text-gray-400'}">
				{isTeam ? "Teams" : "Users"} <span class="ml-1 rounded-full bg-gray-800 px-2">{data.identityMappings.filter(m => m.sourceKind.endsWith(":team") === isTeam).length}</span>
			</button>
		{/each}
	</fieldset>
	<div class="flex flex-wrap items-center gap-2">
		<h2 class="mr-auto w-full text-base font-semibold sm:w-auto">Saved {kind} mappings</h2>
		<button type="button" class="secondary" disabled={!options.length || busy} onclick={() => editor = "csv"}>Import CSV</button>
		<button type="button" class="primary" disabled={!options.length || busy} onclick={() => editor = "manual"}>Add {kind} mapping</button>
	</div>
	{#if !options.length}<p class="text-sm text-gray-400">{teams ? "Team merges are supported for GHES imports only." : "No target organizations configured."} <a href="/setup#targets" class="text-blue-400">Open Setup</a></p>{/if}
	{#if editor && scope}
		<form method="POST" enctype="multipart/form-data" action="?/saveMappings" use:enhance={submit} class="space-y-3 rounded-md border border-gray-700 bg-gray-900 p-4">
			<h3 class="font-semibold">{editor === "csv" ? `Import ${kind} mappings` : `Add ${kind} mapping`}</h3>
			<input type="hidden" name="target" value={scope.target} /><input type="hidden" name="organization" value={scope.organization} />
			<div class="grid gap-3 sm:grid-cols-2">
				<label>GitHub organization
					<select value={key(scope)} onchange={e => {selection = e.currentTarget.value; source = "";}}>
						{#each options as s (key(s))}<option value={key(s)}>{s.host}/{s.organization}</option>{/each}
					</select>
				</label>
				<label>Source identity type<select name="sourceKind" value={sourceKind} onchange={e => source = e.currentTarget.value}>
					{#each sources as [id, label] (id)}<option value={id}>{label}</option>{/each}
				</select></label>
			</div>
			{#if editor === "manual"}
				<div class="grid gap-3 sm:grid-cols-2"><label>{teams ? "Source group or team URL" : "Source identity"}<input name="sourceIdentity" required maxlength="2048" /></label>
					<label>{teams ? "Target team slug" : "Target username"}<input name="targetLogin" required maxlength={teams ? 100 : 39} /></label></div>
			{:else}
				<label>CSV file<input type="file" name="csv" accept=".csv,text/csv" required /></label>
				<p class="text-sm text-gray-400">Header: <code>source_identity,{teams ? "target_team_slug" : "target_username"}</code>. Up to 500 mappings.</p>
			{/if}
			<div class="flex justify-end gap-2"><button type="button" class="secondary" onclick={() => editor = null}>Cancel</button>
				<button type="submit" class="primary" disabled={busy}>{editor === "csv" ? "Import mappings" : "Save mapping"}</button></div>
		</form>
	{/if}
	{#if form?.error || form?.success}<p role="status" class="text-sm {form.error ? 'text-red-400' : 'text-green-400'}">{form.error ?? form.success}</p>{/if}
	<div class="overflow-hidden rounded-md border border-gray-700">
		<div class="hidden grid-cols-[1fr_1fr_5rem] gap-4 bg-gray-900 px-4 py-2 text-sm text-gray-400 sm:grid"><span>Source {teams ? "group or team" : "user"}</span><span>GitHub {kind}</span></div>
		{#each rows as row ([row.targetApiUrl,row.targetOrg,row.sourceKind,row.sourceIdentity].join("\0"))}
			<div class="grid items-center gap-2 border-t border-gray-800 px-4 py-3 sm:grid-cols-[1fr_1fr_5rem] sm:gap-4">
				<span class="min-w-0 break-words font-mono text-sm">{row.sourceIdentity}</span>
				<div class="min-w-0 break-words"><span class="font-mono text-sm">{teams ? "" : "@"}{row.targetLogin}</span><div class="text-sm text-gray-400">{row.host}/{row.targetOrg}</div></div>
				<form method="POST" action="?/removeMapping" use:enhance={submit}>
					<input type="hidden" name="target" value={row.targetId} /><input type="hidden" name="organization" value={row.targetOrg} /><input type="hidden" name="sourceKind" value={row.sourceKind} /><input type="hidden" name="sourceIdentity" value={row.sourceIdentity} />
					<button type="submit" disabled={busy} aria-label={`Remove mapping for ${row.sourceIdentity}`} class="text-sm text-gray-400 hover:text-red-400">Remove</button>
				</form>
			</div>
		{:else}<p class="px-4 py-3 text-sm text-gray-400">No saved {kind} mappings.</p>{/each}
	</div>
	{#if !teams && attributionScopes.length}
		<details><summary class="cursor-pointer text-sm text-gray-300">Post-import mannequin attribution</summary>
			{#each attributionScopes as s (key(s))}
				<form method="POST" use:enhance={submit} class="mt-3 flex flex-wrap items-center gap-2">
					<span class="mr-auto text-sm">{s.host}/{s.organization}</span><input type="hidden" name="target" value={s.target} /><input type="hidden" name="organization" value={s.organization} />
					<button type="submit" formaction="?/checkMappings" disabled={busy} class="secondary">Check mappings</button>
					<button type="submit" formaction="?/applyMappings" disabled={busy} class="secondary">Send matched invitations</button>
				</form>
			{/each}
			{#each form?.checked ?? [] as item (item.sourceKind + item.sourceIdentity)}<p class="mt-2 text-sm">{item.sourceIdentity}: {item.user}{item.match ? ` · ${item.match}` : ""}{item.invitationStatus ? ` · ${item.invitationStatus}` : ""}{item.claimant ? ` · @${item.claimant}` : ""}</p>{/each}
			{#each form?.outcomes ?? [] as item (item.sourceKind + item.sourceIdentity)}<p class="mt-2 text-sm">{item.sourceIdentity}: {item.outcome}</p>{/each}
		</details>
	{/if}
</div>
<style>
	.secondary,.primary { border:1px solid var(--color-gray-600);border-radius:6px;padding:6px 12px;font-size:14px;font-weight:500;background:var(--color-gray-900); }
	.primary {border-color:var(--color-green-700);background:var(--color-green-700);color:white}
	button:disabled {opacity:.5}
	label {display:block;min-width:0;font-size:14px;font-weight:500}
	select,input:not([type=hidden]) {display:block;width:100%;min-width:0;margin-top:4px;border-radius:6px;border:1px solid var(--color-gray-600);background:var(--color-gray-950);padding:8px 12px;font-size:14px}
</style>
