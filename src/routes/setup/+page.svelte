<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { getSourceProviderAdapter } from "$lib/source-provider";

	let { data } = $props();
	const setup = $derived(data.setup);
	const targetProfiles = $derived(data.targetProfiles ?? []);
	const deprecatedAliases = $derived(
		setup.capabilityReport?.deprecatedEnvironmentAliases ?? [],
	);
</script>

<svelte:head><title>Setup - GitHub Migration Toolkit</title></svelte:head>

<div class="mx-auto max-w-5xl space-y-8">
	<header class="flex flex-wrap items-end justify-between gap-4 border-b border-gray-700 pb-5">
		<div>
			<h1 class="text-xl font-semibold text-gray-50">Setup</h1>
			<p class="mt-1 max-w-2xl text-sm text-gray-400">
				Profile and migrate repositories from GitHub, GitLab, or Bitbucket Server/Data Center
				to configured GitHub targets.
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
			<span
				class="inline-flex items-center gap-1.5 {setup.profileReady ? 'text-green-400' : 'text-yellow-400'}"
			>
				<Octicon name={setup.profileReady ? "check-circle-fill" : "alert"} size={16} />
				{setup.profileReady ? "Sources ready" : "Source setup required"}
			</span>
			<span
				class="inline-flex items-center gap-1.5 {setup.automationReady ? 'text-green-400' : 'text-gray-400'}"
			>
				<Octicon
					name={setup.automationReady ? "check-circle-fill" : "circle-slash"}
					size={16}
				/>
				{setup.automationReady ? "Targets ready" : "Migration setup incomplete"}
			</span>
		</div>
	</header>

	{#if deprecatedAliases.length > 0}
		<div class="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
			<div class="flex items-start gap-2">
				<Octicon name="alert" size={16} class="mt-0.5 shrink-0" />
				<div>
					<p class="font-medium">Legacy export settings are active</p>
					<ul class="mt-1 space-y-1 text-xs text-yellow-100/80">
						{#each deprecatedAliases as alias (alias.alias)}
							<li><code>{alias.alias}</code> is supplying <code>{alias.canonical}</code>.</li>
						{/each}
					</ul>
				</div>
			</div>
		</div>
	{/if}

	<div class="grid gap-8 lg:grid-cols-[12rem_minmax(0,1fr)]">
		<aside>
			<nav aria-label="Setup sections" class="grid grid-cols-3 gap-1 lg:sticky lg:top-6 lg:block lg:space-y-1">
				<a href="#sources" class="flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-gray-100">
					<span class="text-xs tabular-nums text-gray-500">1</span>
					<Octicon name="repo" size={16} class="hidden shrink-0 sm:inline-block" />
					Sources
				</a>
				<a href="#targets" class="flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-gray-100">
					<span class="text-xs tabular-nums text-gray-500">2</span>
					<Octicon name="repo-push" size={16} class="hidden shrink-0 sm:inline-block" />
					Targets
				</a>
				<a href="#apply" class="flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-gray-100">
					<span class="text-xs tabular-nums text-gray-500">3</span>
					<Octicon name="terminal" size={16} class="hidden shrink-0 sm:inline-block" />
					Apply
				</a>
			</nav>
		</aside>

		<div class="min-w-0 space-y-10">

	<section id="sources" class="scroll-mt-6 space-y-3" aria-labelledby="source-options-heading">
		<div>
			<h2 id="source-options-heading" class="text-base font-semibold text-gray-100">Source providers</h2>
			<p class="mt-1 text-sm text-gray-500">Credentials and transfer settings used to inspect source repositories.</p>
		</div>
		<div class="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700">
			<section class="bg-gray-950">
				<div class="flex items-center justify-between gap-3 px-4 pt-4">
					<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name="mark-github" size={16} class="text-gray-400" />GitHub</h3>
					<span class="inline-flex items-center gap-1.5 text-xs font-medium {setup.sourceAuthReady ? 'text-green-400' : 'text-yellow-400'}"><Octicon name={setup.sourceAuthReady ? "check-circle-fill" : "alert"} size={12} />{setup.sourceAuthReady ? "Configured" : "Missing credentials"}</span>
				</div>
				<div class="space-y-3 px-4 pt-2 pb-4">
					<p class="text-xs text-gray-500">GitHub.com or GitHub Enterprise Server</p>
					<dl class="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
						<div><dt class="text-xs text-gray-500">API URL</dt><dd class="text-machine mt-0.5 break-all text-gray-300">{setup.sourceApiUrl}</dd></div>
						<div><dt class="text-xs text-gray-500">Organizations</dt><dd class="text-machine mt-0.5 text-gray-300">{setup.sourceOrgs.length ? setup.sourceOrgs.join(", ") : "Set during profiling"}</dd></div>
					</dl>
					{#if setup.sourceAuthReady}
						<p class="flex items-center gap-2 text-xs text-gray-500"><Octicon name="check" size={12} class="text-green-400" />Ready for profiling and migration planning.</p>
					{:else}
						<pre class="text-machine overflow-x-auto rounded-md border border-gray-700 bg-gray-950 p-3 text-gray-300">GH_SOURCE_API_URL={setup.sourceApiUrl}
GH_SOURCE_PAT=github_pat_...</pre>
					{/if}
				</div>
			</section>

			<section class="bg-gray-950">
				<div class="flex items-center justify-between gap-3 px-4 pt-4">
					<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name="gitlab-logo" size={16} class="text-gray-400" />GitLab</h3>
					<span class="inline-flex items-center gap-1.5 text-xs font-medium {setup.gitlabSourceAuthReady ? 'text-green-400' : 'text-yellow-400'}"><Octicon name={setup.gitlabSourceAuthReady ? "check-circle-fill" : "alert"} size={12} />{setup.gitlabMigrationReady ? "Migration ready" : setup.gitlabSourceAuthReady ? "Profile ready" : "Missing credentials"}</span>
				</div>
				<div class="space-y-3 px-4 pt-2 pb-4">
					<p class="text-xs text-gray-500">GitLab.com or self-managed GitLab</p>
					<dl class="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
						<div><dt class="text-xs text-gray-500">API URL</dt><dd class="text-machine mt-0.5 break-all text-gray-300">{setup.gitlabSourceApiUrl || "Not configured"}</dd></div>
						<div><dt class="text-xs text-gray-500">Archive storage</dt><dd class="mt-0.5 {setup.gitlabMigrationReady ? 'text-gray-300' : 'text-gray-400'}">{setup.gitlabMigrationReady ? "Configured" : "Required for migration"}</dd></div>
						<div class="sm:col-span-2"><dt class="text-xs text-gray-500">Migration scope · GITLAB_SOURCE_NAMESPACE</dt><dd class="text-machine mt-0.5 wrap-anywhere text-gray-300">{data.gitlabNamespaces?.join(", ") || "Not restricted by namespace"}</dd></div>
					</dl>
					{#if setup.gitlabMigrationReady}
						<p class="flex items-center gap-2 text-xs text-gray-500"><Octicon name="check" size={12} class="text-green-400" />Ready for profiling and migration.</p>
					{:else}
						<pre class="text-machine overflow-x-auto rounded-md border border-gray-700 bg-gray-950 p-3 text-gray-300">GITLAB_SOURCE_API_URL=https://gitlab.com
GITLAB_SOURCE_PAT=glpat_...
GITLAB_SOURCE_NAMESPACE=group/subgroup
ARCHIVE_DIR=/data/archives</pre>
					{/if}
				</div>
			</section>

			<section class="bg-gray-950">
				<div class="flex items-center justify-between gap-3 px-4 pt-4">
					<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name="bitbucket-logo" size={16} class="text-gray-400" />Bitbucket Server</h3>
					<span class="inline-flex items-center gap-1.5 text-xs font-medium {setup.bitbucketSourceAuthReady ? 'text-green-400' : 'text-yellow-400'}"><Octicon name={setup.bitbucketSourceAuthReady ? "check-circle-fill" : "alert"} size={12} />{setup.bitbucketMigrationReady ? "Migration ready" : setup.bitbucketSourceAuthReady ? "Profile ready" : "Missing credentials"}</span>
				</div>
				<div class="space-y-3 px-4 pt-2 pb-4">
					<p class="text-xs text-gray-500">Bitbucket Server or Data Center 5.14+</p>
					<dl class="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
						<div><dt class="text-xs text-gray-500">API URL</dt><dd class="text-machine mt-0.5 break-all text-gray-300">{setup.bitbucketSourceApiUrl || "Not configured"}</dd></div>
						<div><dt class="text-xs text-gray-500">Export transfer</dt><dd class="mt-0.5 {setup.bitbucketMigrationReady ? 'text-gray-300' : 'text-gray-400'}">{setup.bitbucketMigrationReady ? "SFTP configured" : "SFTP required for migration"}</dd></div>
						<div class="sm:col-span-2"><dt class="text-xs text-gray-500">Migration scope · BITBUCKET_SERVER_PROJECT_KEYS</dt><dd class="text-machine mt-0.5 wrap-anywhere text-gray-300">{data.bitbucketProjectKeys?.join(", ") || "Not restricted by project key"}</dd></div>
					</dl>
					{#if setup.bitbucketMigrationReady}
						<p class="flex items-center gap-2 text-xs text-gray-500"><Octicon name="check" size={12} class="text-green-400" />Ready for profiling and migration.</p>
					{:else}
						<pre class="text-machine overflow-x-auto rounded-md border border-gray-700 bg-gray-950 p-3 text-gray-300">BITBUCKET_SERVER_URL=https://bitbucket.example.com
BITBUCKET_SERVER_USERNAME=migration-user
BITBUCKET_SERVER_PASSWORD=...
BITBUCKET_SERVER_SSH_USERNAME=bitbucket
BITBUCKET_SERVER_SSH_PRIVATE_KEY=...</pre>
					{/if}
				</div>
			</section>
		</div>
	</section>

	<section id="targets" class="scroll-mt-6 space-y-3" aria-labelledby="migration-target-heading">
		<div>
			<h2 id="migration-target-heading" class="text-base font-semibold text-gray-100">Migration targets</h2>
			<p class="mt-1 text-sm text-gray-400">GitHub connections and supported source paths.
				{#if data.currentUser?.role === "admin"}<a href="/admin/targets" class="text-blue-400 hover:underline">Manage target organizations</a>{/if}
			</p>
		</div>
		<div class="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700">
			{#each targetProfiles as profile (profile.id)}
				<article class="bg-gray-950 px-4 py-4">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name={profile.platform === "ghec" ? "cloud" : "server"} size={16} class="text-gray-400" />{profile.displayName}</h3>
						<span class="inline-flex items-center gap-1.5 text-xs font-medium {profile.serverMigrationReady ? 'text-green-400' : 'text-yellow-400'}"><Octicon name={profile.serverMigrationReady ? "check-circle-fill" : "alert"} size={12} />{profile.serverMigrationReady ? "Migration ready" : "Execution setup incomplete"}</span>
					</div>
					<div class="mt-3 space-y-4">
						<dl class="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
							<div><dt class="text-xs text-gray-500">API URL</dt><dd class="text-machine mt-0.5 break-all text-gray-300">{profile.apiUrl}</dd></div>
							<div><dt class="text-xs text-gray-500">Migration credential scope</dt><dd class="text-machine mt-0.5 break-all text-gray-300">{profile.organizations.length ? profile.organizations.join(", ") : "Not restricted by organization"}</dd></div>
						</dl>
						<div class="divide-y divide-gray-700 border-y border-gray-700">
							{#each profile.capabilities ?? [] as capability (`${capability.sourceProvider}:${profile.id}`)}
								<div class="py-2.5">
									<div class="flex items-center justify-between gap-3 text-xs">
										<span class="font-medium text-gray-300">{getSourceProviderAdapter(capability.sourceProvider).displayName}</span>
										<span class={capability.status === "ready" ? "text-green-400" : capability.status === "unsupported" ? "text-gray-500" : "text-yellow-400"}>{capability.status === "ready" ? "Ready" : capability.status === "unsupported" ? "Unsupported" : "Blocked"}</span>
									</div>
									{#if capability.reasons.length}
										<ul class="mt-1.5 space-y-1 text-xs text-gray-500">
											{#each capability.reasons as reason (reason.code)}
												<li>{reason.message}{#if reason.environment.length}<span class="text-machine block text-gray-600">{reason.environment.join(", ")}</span>{/if}</li>
											{/each}
										</ul>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				</article>
			{/each}
		</div>
	</section>

	<section id="apply" class="scroll-mt-6 border-t border-gray-700 pt-6">
		<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<h2 class="flex items-center gap-2 text-base font-semibold text-gray-100"><Octicon name="terminal" size={16} class="text-gray-500" />Apply configuration</h2>
				<p class="mt-1 text-sm text-gray-400">After editing <code class="text-machine rounded bg-gray-800 px-1.5 py-0.5">.env</code>, recreate the service.</p>
				<code class="text-machine mt-3 block rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-300">docker compose up -d --force-recreate</code>
			</div>
			<div class="flex shrink-0 flex-wrap gap-2">
				<a href="/setup" class="setup-button setup-button-default"><Octicon name="sync" size={16} />Check again</a>
				<a href="/profile" class="setup-button setup-button-primary"><Octicon name="telescope" size={16} />{setup.profileReady ? "Start profile" : "Open profile"}</a>
			</div>
		</div>
	</section>
		</div>
	</div>
</div>

<style>
	.setup-button {
		display: inline-flex;
		height: 2rem;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding-inline: 0.75rem;
		border: 1px solid;
		border-radius: 0.375rem;
		box-shadow: var(--button-default-shadow-resting);
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.setup-button:focus-visible {
		outline: 2px solid var(--fgColor-accent);
		outline-offset: 2px;
	}

	.setup-button-default {
		border-color: var(--button-default-borderColor-rest);
		background: var(--button-default-bgColor-rest);
		color: var(--button-default-fgColor-rest);
	}

	.setup-button-default:hover {
		background: var(--button-default-bgColor-hover);
	}

	.setup-button-primary {
		border-color: var(--button-primary-borderColor-rest);
		background: var(--button-primary-bgColor-rest);
		color: var(--button-primary-fgColor-rest);
	}

	.setup-button-primary:hover {
		background: var(--button-primary-bgColor-hover);
	}
</style>