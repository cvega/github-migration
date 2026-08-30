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

<div class="mx-auto max-w-6xl space-y-6">
	<header class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<div class="mb-2 flex items-center gap-2 text-sm font-medium text-blue-400">
				<Octicon name="gear" size={16} />First-time setup
			</div>
			<h1 class="text-2xl font-semibold text-gray-50">Prepare profiling and migration</h1>
			<p class="mt-2 max-w-2xl text-sm text-gray-400">
				Profile and migrate repositories from GitHub, GitLab, or Bitbucket Server/Data Center
				to configured GitHub targets.
			</p>
		</div>
		<div class="flex flex-col items-end gap-2">
			<span
				class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium {setup.profileReady
					? 'bg-green-500/15 text-green-300'
					: 'bg-yellow-500/15 text-yellow-300'}"
			>
				<Octicon name={setup.profileReady ? "check-circle-fill" : "alert"} size={16} />
				{setup.profileReady ? "Source ready to profile" : "Source setup required"}
			</span>
			<span
				class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium {setup.automationReady
					? 'bg-green-500/15 text-green-300'
					: 'bg-gray-800 text-gray-400'}"
			>
				<Octicon
					name={setup.automationReady ? "check-circle-fill" : "circle-slash"}
					size={16}
				/>
				{setup.automationReady ? "Migration ready" : "Migration setup incomplete"}
			</span>
		</div>
	</header>

	<ol class="grid grid-cols-3 overflow-hidden rounded-md border border-gray-700 bg-gray-900 text-sm">
		<li class="flex items-center gap-2 border-r border-gray-700 px-3 py-3 text-gray-200 sm:px-4">
			<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-xs font-semibold text-violet-300">1</span>
			<span class="hidden sm:inline">Connect source</span><span class="sm:hidden">Source</span>
		</li>
		<li class="flex items-center gap-2 border-r border-gray-700 px-3 py-3 text-gray-200 sm:px-4">
			<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-xs font-semibold text-blue-300">2</span>
			<span class="hidden sm:inline">Connect target</span><span class="sm:hidden">Target</span>
		</li>
		<li class="flex items-center gap-2 px-3 py-3 text-gray-200 sm:px-4">
			<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-500/15 text-xs font-semibold text-green-300">3</span>
			<span class="hidden sm:inline">Profile and migrate</span><span class="sm:hidden">Run</span>
		</li>
	</ol>

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

	<section class="space-y-3" aria-labelledby="source-options-heading">
		<div>
			<h2 id="source-options-heading" class="text-sm font-semibold text-gray-200">Source options</h2>
			<p class="mt-1 text-xs text-gray-500">Configure any source provider for profiling.</p>
		</div>
		<div class="grid gap-5 lg:grid-cols-3">
			<section class="overflow-hidden rounded-md border border-gray-700 bg-gray-900">
				<div class="flex items-center justify-between border-b border-gray-700 bg-gray-800/40 px-5 py-3">
					<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name="mark-github" size={16} class="text-violet-400" />GitHub source</h3>
					<span class="text-xs font-medium {setup.sourceAuthReady ? 'text-green-400' : 'text-yellow-400'}">{setup.sourceAuthReady ? "Configured" : "Missing credentials"}</span>
				</div>
				<div class="space-y-4 p-5">
					<p class="text-xs text-gray-500">GitHub.com or GitHub Enterprise Server</p>
					<dl class="space-y-2 text-sm">
						<div class="flex justify-between gap-4"><dt class="text-gray-500">API URL</dt><dd class="text-machine min-w-0 break-all text-right text-gray-300">{setup.sourceApiUrl}</dd></div>
						<div class="flex justify-between gap-4"><dt class="text-gray-500">Organizations</dt><dd class="text-machine min-w-0 text-right text-gray-300">{setup.sourceOrgs.length ? setup.sourceOrgs.join(", ") : "Set during profiling"}</dd></div>
					</dl>
					{#if setup.sourceAuthReady}
						<p class="flex gap-2 text-sm text-green-300"><Octicon name="check" size={16} />Ready for profiling and migration planning.</p>
					{:else}
						<pre class="text-machine overflow-x-auto rounded-md border border-gray-700 bg-gray-950 p-3 text-gray-300">GH_SOURCE_API_URL={setup.sourceApiUrl}
GH_SOURCE_PAT=github_pat_...</pre>
					{/if}
				</div>
			</section>

			<section class="overflow-hidden rounded-md border border-gray-700 bg-gray-900">
				<div class="flex items-center justify-between border-b border-gray-700 bg-gray-800/40 px-5 py-3">
					<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name="gitlab-logo" size={16} />GitLab source</h3>
					<span class="text-xs font-medium {setup.gitlabSourceAuthReady ? 'text-green-400' : 'text-yellow-400'}">{setup.gitlabMigrationReady ? "Migration ready" : setup.gitlabSourceAuthReady ? "Profile ready" : "Missing credentials"}</span>
				</div>
				<div class="space-y-4 p-5">
					<p class="text-xs text-gray-500">GitLab.com or self-managed GitLab</p>
					<dl class="space-y-2 text-sm">
						<div class="flex justify-between gap-4"><dt class="text-gray-500">API URL</dt><dd class="text-machine min-w-0 break-all text-right text-gray-300">{setup.gitlabSourceApiUrl || "Not configured"}</dd></div>
						<div class="flex justify-between gap-4"><dt class="text-gray-500">Archive storage</dt><dd class="text-right text-xs {setup.gitlabMigrationReady ? 'text-green-300' : 'text-gray-400'}">{setup.gitlabMigrationReady ? "Configured" : "Required for migration"}</dd></div>
					</dl>
					{#if setup.gitlabMigrationReady}
						<p class="flex gap-2 text-sm text-green-300"><Octicon name="check" size={16} />Ready for profiling and migration.</p>
					{:else}
						<pre class="text-machine overflow-x-auto rounded-md border border-gray-700 bg-gray-950 p-3 text-gray-300">GITLAB_SOURCE_API_URL=https://gitlab.com
GITLAB_SOURCE_PAT=glpat_...
GITLAB_SOURCE_NAMESPACE=group/subgroup
ARCHIVE_DIR=/data/archives</pre>
					{/if}
				</div>
			</section>

			<section class="overflow-hidden rounded-md border border-gray-700 bg-gray-900">
				<div class="flex items-center justify-between border-b border-gray-700 bg-gray-800/40 px-5 py-3">
					<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name="bitbucket-logo" size={16} />Bitbucket source</h3>
					<span class="text-xs font-medium {setup.bitbucketSourceAuthReady ? 'text-green-400' : 'text-yellow-400'}">{setup.bitbucketMigrationReady ? "Migration ready" : setup.bitbucketSourceAuthReady ? "Profile ready" : "Missing credentials"}</span>
				</div>
				<div class="space-y-4 p-5">
					<p class="text-xs text-gray-500">Bitbucket Server or Data Center 5.14+</p>
					<dl class="space-y-2 text-sm">
						<div class="flex justify-between gap-4"><dt class="text-gray-500">API URL</dt><dd class="text-machine min-w-0 break-all text-right text-gray-300">{setup.bitbucketSourceApiUrl || "Not configured"}</dd></div>
						<div class="flex justify-between gap-4"><dt class="text-gray-500">Export transfer</dt><dd class="text-right text-xs {setup.bitbucketMigrationReady ? 'text-green-300' : 'text-gray-400'}">{setup.bitbucketMigrationReady ? "SFTP configured" : "SFTP required for migration"}</dd></div>
					</dl>
					{#if setup.bitbucketMigrationReady}
						<p class="flex gap-2 text-sm text-green-300"><Octicon name="check" size={16} />Ready for profiling and migration.</p>
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

	<section class="space-y-3" aria-labelledby="migration-target-heading">
		<div>
			<h2 id="migration-target-heading" class="text-sm font-semibold text-gray-200">Migration targets</h2>
			<p class="mt-1 text-xs text-gray-500">Targets are configured by your administrator.</p>
		</div>
		<div class="space-y-3">
			{#each targetProfiles as profile (profile.id)}
				<div class="overflow-hidden rounded-md border border-gray-700 bg-gray-900">
					<div class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-700 bg-gray-800/40 px-5 py-3">
						<h3 class="flex items-center gap-2 font-medium text-gray-100"><Octicon name={profile.platform === "ghec" ? "cloud" : "server"} size={16} class="text-blue-400" />{profile.displayName}</h3>
						<span class="text-xs font-medium {profile.serverMigrationReady ? 'text-green-400' : 'text-yellow-400'}">{profile.serverMigrationReady ? "Migration ready" : "Execution setup incomplete"}</span>
					</div>
					<div class="space-y-4 p-5">
						<dl class="grid gap-2 text-sm sm:grid-cols-2">
							<div><dt class="text-gray-500">API URL</dt><dd class="text-machine break-all text-gray-300">{profile.apiUrl}</dd></div>
							<div><dt class="text-gray-500">Organizations</dt><dd class="text-machine break-all text-gray-300">{profile.organizations.length ? profile.organizations.join(", ") : "Set in migration plan"}</dd></div>
						</dl>
						<div class="divide-y divide-gray-800 rounded-md border border-gray-700 bg-gray-950/50">
							{#each profile.capabilities ?? [] as capability (`${capability.sourceProvider}:${profile.id}`)}
								<div class="px-3 py-2.5">
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
				</div>
			{/each}
		</div>
	</section>

	<section class="rounded-md border border-gray-700 bg-gray-900 p-5">
		<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<h2 class="flex items-center gap-2 text-sm font-medium text-gray-200"><Octicon name="terminal" size={16} class="text-gray-500" />Apply configuration</h2>
				<p class="mt-1 text-sm text-gray-400">After editing <code class="text-machine rounded bg-gray-800 px-1.5 py-0.5">.env</code>, recreate the service.</p>
				<code class="text-machine mt-2 block text-gray-300">docker compose up -d --force-recreate</code>
			</div>
			<div class="flex shrink-0 flex-wrap gap-2">
				<a href="/setup" class="inline-flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700"><Octicon name="sync" size={16} />Check again</a>
				<a href="/profile" class="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"><Octicon name="telescope" size={16} />{setup.profileReady ? "Start profile" : "Open Profile"}</a>
			</div>
		</div>
	</section>
</div>