<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { PageProps, SubmitFunction } from "./$types";

	let { data, form }: PageProps = $props();
	const connections = $derived(data.connections.map((c) => ({
		...c, label: c.platform === "ghec" ? "Cloud" : "Server",
		host: new URL(c.apiUrl).host, editor: `?add=${encodeURIComponent(c.id)}`
	})));
	const total = $derived(connections.reduce((n, c) => n + c.entries.length, 0));
	const editing = $derived(connections.find((c) => c.id === page.url.searchParams.get("add")));
	const discovery = $derived(editing && form?.discovery?.key === editing.key ? form.discovery : null);
	let request = $state.raw<{ key: string; operation: "add" | "discover" } | null>(null);
	const pending = $derived(request?.key === editing?.key ? request?.operation : null);
	const submit: SubmitFunction = ({ action, cancel }) => {
		if (pending || !editing) { cancel(); return; }
		const operation = action.searchParams.has("/discover") ? "discover" : "add";
		const submission = { key: editing.key, operation } as const;
		request = submission;
		return async ({ update, result }) => {
			try {
				if (request === submission && page.url.pathname === action.pathname && editing?.key === submission.key) {
					await update({ invalidateAll: operation === "add" });
				} else if (operation === "add" && result.type === "success") {
					await invalidateAll();
				}
			} finally { if (request === submission) request = null; }
		};
	};
</script>

<svelte:head><title>Target organizations - GitHub Migration Toolkit</title></svelte:head>

<div class="mx-auto max-w-5xl text-sm text-gray-100">
	<a href="/admin/users" class="inline-flex min-h-9 items-center gap-1 text-gray-400 hover:text-gray-100"><Octicon name="chevron-left" />Users</a>
	<header class="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
		<div class="min-w-0">
			<h1 class="text-2xl font-semibold sm:text-[2rem] sm:leading-10">Target organizations</h1>
			<p class="mt-2 max-w-xl text-gray-400">List GitHub destinations here. To grant access, map a profiled source to a target on the user’s page.</p>
		</div>
		{#if !editing && connections[0]}
			<a href={connections[0].editor} class="primary-action"><Octicon name="plus" />Add target</a>
		{/if}
	</header>

	{#if form?.error}<p role="alert" class="mt-4 rounded-md border border-red-500/40 px-3 py-2 text-red-300">{form.error}</p>{/if}
	{#if form?.success}<p role="status" class="mt-4 rounded-md border border-green-500/40 px-3 py-2 text-green-300">{form.success}</p>{/if}

	{#if editing}
		{#key editing.key}
			<section aria-labelledby="add-heading" class="mt-6 rounded-md border border-gray-600 bg-gray-900 p-4 sm:p-5">
				<div class="flex items-center justify-between gap-3">
					<h2 id="add-heading" class="text-lg font-semibold">Add target</h2>
					<a href="/admin/targets" class="inline-flex min-h-9 items-center text-gray-400 hover:text-gray-100">Close</a>
				</div>
				<p class="mb-4 text-gray-400">List an existing organization. This does not create it on GitHub.</p>
				<p class="mb-1 font-medium">GitHub connection</p>
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
					<nav aria-label="Target connection" class="inline-flex rounded-md border border-gray-600 p-0.5">
						{#each connections as c (c.key)}
							<a href={c.editor} aria-current={c.key === editing.key ? "page" : undefined}
								class="connection-choice"><Octicon name={c.platform === "ghec" ? "cloud" : "server"} />{c.label}</a>
						{/each}
					</nav>
					<span class="min-w-0 wrap-anywhere font-mono text-xs text-gray-400">{editing.host}</span>
				</div>
				<div class="mt-4 flex flex-wrap items-end gap-x-4 gap-y-1">
					<form method="POST" action={`${editing.editor}&/add`} use:enhance={submit} class="grid w-full max-w-sm grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
						<input type="hidden" name="connection" value={editing.key} />
						<label class="min-w-0 font-medium">Organization login
							<input required name="org" maxlength="39" autocomplete="off" placeholder="e.g. engineering" class="mt-1 block min-h-10 w-full rounded-md border border-gray-600 bg-gray-950 px-3 font-normal" />
						</label>
						<button type="submit" disabled={!!pending} class="primary-action">Add target</button>
					</form>
					<form method="POST" action={`${editing.editor}&/discover`} use:enhance={submit}>
						<input type="hidden" name="connection" value={editing.key} />
						<button type="submit" disabled={!!pending} class="text-action"><Octicon name="search" />{pending === "discover" ? "Finding organizations…" : "Find organizations"}</button>
					</form>
				</div>
				{#if discovery}
					<div class="mt-5">
						<h3 class="font-semibold">Organizations visible to {editing.label}</h3>
						{#if discovery.organizations.length}
							<ul class="mt-1 divide-y divide-gray-700">
								{#each discovery.organizations as org (org)}
									<li class="flex items-center justify-between gap-3 py-1">
										<span class="text-machine min-w-0 wrap-anywhere">{org}</span>
										{#if editing.entries.some((entry) => entry.org.toLowerCase() === org.toLowerCase())}
											<span class="shrink-0 text-xs text-gray-400">Already listed</span>
										{:else}
											<form method="POST" action={`${editing.editor}&/add`} use:enhance={submit}>
												<input type="hidden" name="connection" value={editing.key} /><input type="hidden" name="org" value={org} />
												<button type="submit" disabled={!!pending} aria-label={`Add ${org} to ${editing.label}`} class="text-action">Add</button>
											</form>
										{/if}
									</li>
								{/each}
							</ul>
						{:else}<p class="text-gray-400">No organizations returned on this page. You can still enter a known login.</p>{/if}
						{#if discovery.next !== null}
							<form method="POST" action={`${editing.editor}&/discover`} use:enhance={submit}>
								<input type="hidden" name="connection" value={editing.key} /><input type="hidden" name="cursor" value={discovery.next} />
								<button type="submit" disabled={!!pending} class="text-action">Next page<Octicon name="arrow-right" /></button>
							</form>
						{/if}
					</div>
				{/if}
			</section>
		{/key}
	{/if}

	<section aria-labelledby="destinations-heading" class="mt-7">
		<header class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
			<h2 id="destinations-heading" class="text-lg font-semibold">Destination directory</h2>
			<p class="text-xs tabular-nums text-gray-400">{total} {total === 1 ? "target" : "targets"} on {connections.length} {connections.length === 1 ? "connection" : "connections"}</p>
		</header>
		<div class="directory rounded-md border border-gray-700">
			<div aria-hidden="true" class="column-head rounded-t-md bg-gray-900 text-xs font-medium text-gray-400">
				<span>GitHub connection</span><span>Organization</span><span>Target allows</span>
			</div>
			{#each connections as c (c.key)}
				<section aria-label={`${c.label} target organizations`} class="connection-row">
					<header class="flex min-w-0 items-start gap-3">
						<span class="grid size-9 shrink-0 place-items-center rounded-md bg-blue-500/10 text-blue-300"><Octicon name={c.platform === "ghec" ? "cloud" : "server"} size={24} /></span>
						<div class="min-w-0"><h3 class="font-semibold">GitHub {c.label}</h3><p class="wrap-anywhere text-xs text-gray-400">{c.host}</p></div>
					</header>
					<ul class="min-w-0 divide-y divide-gray-700">
						{#each c.entries as entry (entry.org)}
							{@const viewOnly = c.scopePinned && !entry.configured}
							<li class="org-row">
								<div class="flex min-w-0 items-baseline gap-2">
									<Octicon name="arrow-right" class="shrink-0 self-start mt-0.5 text-gray-400" />
									<div class="min-w-0">
										<strong class="text-machine wrap-anywhere">{entry.org}</strong>
										<p class="text-xs text-gray-400">{entry.configured ? "From configuration" : "Added by an admin"}</p>
									</div>
								</div>
								<div class="scope-cell">
									<span class="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium"><Octicon name={viewOnly ? "eye" : "check"} class="text-gray-400" /><span><span class="sr-only">This target allows: </span>{viewOnly ? "View only" : "View or migrate"}</span></span>
									{#if !entry.configured}
										<form method="POST" action="?/remove" use:enhance>
											<input type="hidden" name="connection" value={c.key} /><input type="hidden" name="org" value={entry.org} />
											<button type="submit" aria-label={`Remove ${entry.org} from ${c.label}`} class="min-h-9 rounded px-1 text-xs text-gray-400 hover:text-red-300">Remove</button>
										</form>
									{/if}
								</div>
							</li>
						{:else}
							<li class="py-3 text-gray-400">No targets listed. <a href={c.editor} class="text-blue-400 hover:underline">Add a {c.label} target</a></li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</section>

	<details class="group mt-3">
		<summary class="inline-flex min-h-10 cursor-pointer list-none items-center gap-2 rounded text-sm font-medium text-gray-400 hover:text-gray-100 [&::-webkit-details-marker]:hidden">
			<Octicon name="chevron-right" class="group-open:rotate-90" />Connection details
		</summary>
		<div class="max-w-3xl space-y-3 pb-4 pl-6 text-sm text-gray-400">
			<p>“View or migrate” describes what the target allows, not what a user can do. Migration also requires an eligible source, valid credentials and permission on the user’s mapping.</p>
			<dl class="space-y-2">
				{#each connections as c (c.key)}
					<div>
						<dt class="font-semibold text-gray-100">{c.label} <span class="wrap-anywhere font-mono text-xs font-normal text-gray-400">{c.apiUrl}</span></dt>
						<dd>{#if c.scopePinned}Only organizations in <code>{c.platform === "ghec" ? "GH_TARGET_ORG" : "GHES_TARGET_ORG"}</code> are in target scope. Other entries are view only.{:else}No organization allowlist is set for this connection.{/if}</dd>
					</div>
				{/each}
			</dl>
			<p>Change configured targets in deployment settings. To remove an admin-added target, remove its user mappings first.</p>
		</div>
	</details>
</div>

<style>
	.primary-action, .text-action, .connection-choice {
		display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
		min-height: 2.5rem; border-radius: 0.375rem; white-space: nowrap;
	}
	.primary-action { padding-inline: 1rem; background: var(--button-primary-bgColor-rest); color: var(--button-primary-fgColor-rest); font-weight: 600; }
	.primary-action:hover { background: var(--button-primary-bgColor-hover); }
	.text-action { color: var(--fgColor-accent); }
	.text-action:hover { text-decoration: underline; }
	.primary-action:disabled, .text-action:disabled { opacity: 0.6; }
	.connection-choice { min-height: 2.25rem; padding-inline: 0.75rem; color: var(--fgColor-muted); }
	.connection-choice:hover { color: var(--fgColor-default); }
	.connection-choice[aria-current="page"] { background: var(--bgColor-accent-muted); color: var(--fgColor-accent); font-weight: 600; }
	.directory { --connection: clamp(13rem, 32%, 20rem); --scope: 9rem; }
	.column-head { display: none; }
	.connection-row { padding: 1rem; }
	.connection-row + .connection-row { border-top: 1px solid var(--borderColor-default); }
	.org-row { display: grid; gap: 0.25rem; padding: 0.75rem 0; }
	.scope-cell { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.75rem; padding-left: 1.5rem; }
	@media (min-width: 44rem) {
		.column-head, .connection-row { display: grid; column-gap: 1rem; padding-inline: 1.25rem; }
		.column-head { grid-template-columns: var(--connection) minmax(0,1fr) var(--scope); padding-block: 0.625rem; }
		.column-head > :nth-child(2) { padding-left: 1.5rem; }
		.connection-row { grid-template-columns: var(--connection) minmax(0,1fr); border-top: 1px solid var(--borderColor-default); padding-block: 0; }
		.connection-row > header { padding-block: 1rem; }
		.org-row { grid-template-columns: minmax(0,1fr) var(--scope); column-gap: 1rem; align-items: baseline; padding-block: 1rem; }
		.scope-cell { align-items: baseline; padding-left: 0; }
	}
</style>
