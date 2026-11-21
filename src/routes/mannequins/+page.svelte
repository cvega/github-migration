<script lang="ts">
	import { untrack } from "svelte";
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import Octicon from "$lib/components/Octicon.svelte";

	let { data, form } = $props();
	let sourceKind = $state(untrack(() => data.target.platform === "ghes" ? "ghe-migrator:bitbucket-server" : "mannequin-login"));
	let busy = $state(false);
	const mappings = $derived(data.identityMappings.filter((mapping) => mapping.sourceKind !== "mannequin"));
	const priorInvitations = $derived(data.identityMappings.filter((mapping) => mapping.sourceKind === "mannequin"));
	const hasMannequinMappings = $derived(mappings.some((mapping) => mapping.sourceKind.startsWith("mannequin-") && mapping.targetLogin));
	const actionSuffix = $derived(`target=${encodeURIComponent(data.target.id)}&org=${encodeURIComponent(data.organization ?? "")}`);

	function changeTarget(event: Event) {
		const target = (event.currentTarget as HTMLSelectElement).value;
		sourceKind = data.targets.find((item) => item.id === target)?.platform === "ghes" ? "ghe-migrator:bitbucket-server" : "mannequin-login";
		goto(`/mannequins?${new URLSearchParams({ target })}`);
	}

	function changeOrganization(event: Event) {
		const org = (event.currentTarget as HTMLSelectElement).value;
		goto(`/mannequins?${new URLSearchParams({ target: data.target.id, org })}`);
	}

	function enhanceAction() {
		busy = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			try { await update(); } finally { busy = false; }
		};
	}

	function labelKind(kind: string) {
		return ({
			"ghe-migrator:bitbucket-server": "Bitbucket user URL",
			"ghe-migrator:gitlab": "GitLab user URL",
			"mannequin-login": "Mannequin login",
			"mannequin-id": "Mannequin node ID",
		} as Record<string, string>)[kind] ?? kind;
	}

	function userLabel(state: string) {
		return ({
			ready: "Organization member",
			pending: "Organization invitation pending",
			not_member: "Not a visible organization member",
			not_found: "User not found or not visible",
			unmapped: "Target needed",
		} as Record<string, string>)[state] ?? state;
	}
</script>

<svelte:head><title>Identity mappings - GitHub Migration Toolkit</title></svelte:head>

<div class="space-y-6">
	<header class="flex flex-col gap-4 border-b border-gray-700 pb-5 lg:flex-row lg:items-end lg:justify-between">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold text-gray-50"><Octicon name="people" size={24} class="text-gray-300" />Identity mappings</h1>
			<p class="mt-1 max-w-2xl text-sm leading-6 text-gray-400">Prepare source-to-target identities, then check users and apply mannequin invitations.</p>
		</div>
		<div class="flex flex-col gap-3 sm:flex-row">
			<label class="flex flex-col gap-1 text-xs font-medium text-gray-400">Target platform
				<select value={data.target.id} onchange={changeTarget} class="h-9 min-w-52 rounded-md border border-gray-600 bg-gray-900 px-3 text-sm text-gray-100">
					{#each data.targets as target (target.id)}
						<option value={target.id}>{target.platform === "ghec" ? "GitHub Enterprise Cloud" : `GitHub Enterprise Server · ${target.displayName}`}</option>
					{/each}
				</select>
			</label>
			{#if data.targetOrganizations.length}
				<label class="flex flex-col gap-1 text-xs font-medium text-gray-400">Target organization
					<select value={data.organization ?? ""} onchange={changeOrganization} class="h-9 min-w-52 rounded-md border border-gray-600 bg-gray-900 px-3 text-sm text-gray-100">
						{#each data.targetOrganizations as organization (organization)}<option value={organization}>{organization}</option>{/each}
					</select>
				</label>
			{/if}
		</div>
	</header>

	{#if !data.organization}
		<p class="text-sm text-gray-400">Configure a target organization in <a class="text-blue-400 underline" href="/setup#targets">Setup</a> to manage mappings.</p>
	{:else}
		<section class="space-y-4" aria-labelledby="add-heading">
			<div>
				<h2 id="add-heading" class="text-base font-semibold text-gray-100">Add mappings</h2>
				<p class="mt-1 text-sm text-gray-400">Save mappings before users join or mannequins exist. Source identities must match exactly.</p>
			</div>
			<label class="flex max-w-sm flex-col gap-1 text-sm text-gray-300">Source identity type
				<select bind:value={sourceKind} class="h-9 rounded-md border border-gray-600 bg-gray-900 px-3 text-sm text-gray-100">
					{#if data.target.platform === "ghes"}
						<option value="ghe-migrator:bitbucket-server">Bitbucket user URL · GHES import</option>
						<option value="ghe-migrator:gitlab">GitLab user URL · GHES import</option>
					{/if}
					<option value="mannequin-login">Mannequin login · attribution invitation</option>
					<option value="mannequin-id">Mannequin node ID · attribution invitation</option>
				</select>
			</label>
			<form method="POST" action="?/saveMappings&{actionSuffix}" use:enhance={enhanceAction} class="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
				<input type="hidden" name="target" value={data.target.id} />
				<input type="hidden" name="organization" value={data.organization} />
				<input type="hidden" name="sourceKind" value={sourceKind} />
				<label class="flex min-w-0 flex-[2] flex-col gap-1 text-sm text-gray-300">Source identity
					<input name="sourceIdentity" required maxlength="2048" placeholder={sourceKind.startsWith("ghe-migrator:") ? "https://source.example/users/alice" : "Exact mannequin login or node ID"} class="h-9 min-w-0 rounded-md border border-gray-600 bg-gray-900 px-3 text-sm text-gray-100" />
				</label>
				<label class="flex min-w-0 flex-1 flex-col gap-1 text-sm text-gray-300">Target username
					<input name="targetLogin" required maxlength="39" placeholder="GitHub username" class="h-9 min-w-0 rounded-md border border-gray-600 bg-gray-900 px-3 text-sm text-gray-100" />
				</label>
				<button type="submit" disabled={busy} class="h-9 rounded-md bg-green-700 px-4 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50">Add mapping</button>
			</form>
			<details class="text-sm">
				<summary class="cursor-pointer text-blue-400">Import CSV instead</summary>
				<form method="POST" enctype="multipart/form-data" action="?/saveMappings&{actionSuffix}" use:enhance={enhanceAction} class="mt-3 flex flex-wrap items-end gap-3">
					<input type="hidden" name="target" value={data.target.id} />
					<input type="hidden" name="organization" value={data.organization} />
					<input type="hidden" name="sourceKind" value={sourceKind} />
					<label class="flex flex-col gap-1 text-gray-300">CSV file
						<input type="file" name="csv" accept=".csv,text/csv" required class="max-w-full text-sm text-gray-300" />
					</label>
					<button type="submit" disabled={busy} class="h-9 rounded-md border border-gray-600 px-3 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50">Import mappings</button>
					<p class="w-full text-xs text-gray-400">Header: <code>source_identity,target_username</code>. Up to 500 rows; use the selected identity type for every row.</p>
				</form>
			</details>
		</section>

		{#if form?.error || form?.success}
			<p role="status" class="text-sm {form.error ? 'text-red-400' : 'text-green-400'}">{form.error ?? form.success}</p>
		{/if}
		{#if data.error || !data.targetAuthReady}
			<p role="alert" class="text-sm text-amber-400">{data.error ?? "Target authentication is not configured. You can save mappings, but checks and invitations need a target credential."}</p>
		{/if}

		<section aria-labelledby="mappings-heading" class="space-y-3 border-t border-gray-700 pt-5">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div><h2 id="mappings-heading" class="text-base font-semibold text-gray-100">Saved mappings <span class="text-gray-500">({mappings.length})</span></h2>
					<p class="mt-1 text-sm text-gray-400">Check organization membership and find exact mannequin matches.</p></div>
				<div class="flex flex-wrap gap-2">
					<form method="POST" action="?/checkMappings&{actionSuffix}" use:enhance={enhanceAction}>
						<input type="hidden" name="target" value={data.target.id} /><input type="hidden" name="organization" value={data.organization} />
						<button type="submit" disabled={busy || mappings.length === 0} class="h-9 rounded-md border border-gray-600 px-3 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50">{busy ? "Working…" : "Check mappings"}</button>
					</form>
					{#if hasMannequinMappings}
						<form method="POST" action="?/applyMappings&{actionSuffix}" use:enhance={enhanceAction}>
							<input type="hidden" name="target" value={data.target.id} /><input type="hidden" name="organization" value={data.organization} />
							<button type="submit" disabled={busy} class="h-9 rounded-md border border-gray-600 px-3 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50">Send matched invitations</button>
						</form>
					{/if}
				</div>
			</div>
			{#if mappings.length === 0}
				<p class="py-6 text-sm text-gray-500">No mappings saved. Add one above or import a CSV.</p>
			{:else}
				<ul class="divide-y divide-gray-800 border-y border-gray-800">
					{#each mappings as mapping (`${mapping.sourceKind}:${mapping.sourceIdentity}`)}
						{@const check = form?.checked?.find((item) => item.sourceKind === mapping.sourceKind && item.sourceIdentity === mapping.sourceIdentity)}
						{@const outcome = form?.outcomes?.find((item) => item.sourceKind === mapping.sourceKind && item.sourceIdentity === mapping.sourceIdentity)}
						<li class="grid gap-3 py-4 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-start">
							<div class="min-w-0"><p class="break-all font-mono text-sm text-gray-100">{mapping.sourceIdentity}</p><p class="mt-1 text-xs text-gray-500">{labelKind(mapping.sourceKind)}</p></div>
							<div class="min-w-0">
								{#if mapping.targetLogin}<p class="break-all text-sm text-gray-200">@{mapping.targetLogin}</p>
								{:else}
									<form method="POST" action="?/saveMappings&{actionSuffix}" use:enhance={enhanceAction} class="flex gap-2">
										<input type="hidden" name="target" value={data.target.id} /><input type="hidden" name="organization" value={data.organization} />
										<input type="hidden" name="sourceKind" value={mapping.sourceKind} /><input type="hidden" name="sourceIdentity" value={mapping.sourceIdentity} />
										<input name="targetLogin" required maxlength="39" placeholder="GHES username" aria-label={`Target username for ${mapping.sourceIdentity}`} class="h-9 min-w-0 flex-1 rounded-md border border-gray-600 bg-gray-900 px-3 text-sm text-gray-100" />
										<button type="submit" disabled={busy} class="h-9 rounded-md border border-gray-600 px-3 text-sm text-gray-200 disabled:opacity-50">Save</button>
									</form>
								{/if}
								{#if check}<p class="mt-1 text-xs text-gray-400">{userLabel(check.user)}{#if check.match} · Mannequin: {check.match}{/if}{#if check.claimant} · Claimed by @{check.claimant}{:else if check.invitationStatus} · {check.invitationStatus.replaceAll("_", " ")}{#if check.invitationTarget} to @{check.invitationTarget}{/if}{/if}</p>{/if}
								{#if outcome}<p class="mt-1 text-xs text-gray-400">Result: {outcome.outcome}</p>{/if}
							</div>
							<form method="POST" action="?/removeMapping&{actionSuffix}" use:enhance={enhanceAction}>
								<input type="hidden" name="target" value={data.target.id} /><input type="hidden" name="organization" value={data.organization} />
								<input type="hidden" name="sourceKind" value={mapping.sourceKind} /><input type="hidden" name="sourceIdentity" value={mapping.sourceIdentity} />
								<button type="submit" disabled={busy} class="h-9 rounded-md px-2 text-sm text-gray-400 hover:text-red-400 disabled:opacity-50" aria-label={`Remove mapping for ${mapping.sourceIdentity}`}>Remove</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
			<p class="text-xs leading-5 text-gray-500">GHES user URLs are applied during import. Mannequin invitations are sent only for unique matches and active organization members; acceptance is shown on the next check. Verify uncertain or rejected invitations in GitHub.</p>
		</section>

		{#if data.target.platform === "ghes" && data.failedGhesJobs.length}
			<details class="border-t border-gray-800 pt-4 text-sm">
				<summary class="cursor-pointer text-blue-400">Discover conflicts from a failed GHES migration</summary>
				<p class="mt-2 text-gray-400">This reads conflicts over SSH and can take several minutes. Only run one at a time.</p>
				<div class="mt-3 flex flex-wrap gap-2">
					{#each data.failedGhesJobs as job (job.migrationId)}
						<form method="POST" action="?/discover&{actionSuffix}" use:enhance={enhanceAction}>
							<input type="hidden" name="target" value={data.target.id} /><input type="hidden" name="organization" value={data.organization} /><input type="hidden" name="migrationId" value={job.migrationId} />
							<button type="submit" disabled={busy} class="rounded-md border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50">{busy ? "Working…" : `Load ${job.source} · ${job.startedAt.slice(0, 16).replace("T", " ")} UTC`}</button>
						</form>
					{/each}
				</div>
			</details>
		{/if}
		{#if priorInvitations.length}
			<details class="text-sm"><summary class="cursor-pointer text-gray-400">Previously recorded invitations ({priorInvitations.length})</summary>
				<ul class="mt-2 space-y-1 text-xs text-gray-500">{#each priorInvitations as invitation (invitation.sourceIdentity)}<li>{invitation.sourceIdentity}: {invitation.status.replaceAll("_", " ")} to @{invitation.targetLogin}</li>{/each}</ul>
			</details>
		{/if}
	{/if}
</div>
