<!-- New migration form — single or batch -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Octicon from '$lib/components/Octicon.svelte';
	import AuthModeFields from '$lib/components/AuthModeFields.svelte';
	import OrgSelect from '$lib/components/OrgSelect.svelte';
	import { createMigrationForm } from '$lib/migration-form.svelte';

	let mode = $state<'single' | 'batch'>('single');

	// ── Pre-configured defaults (env) ───────────────────────────────────────
	const sourceOrgs = $derived(page.data.formDefaults?.sourceOrgs ?? []);
	const targetOrgs = $derived(page.data.formDefaults?.targetOrgs ?? []);
	const hasSourceOrgs = $derived(sourceOrgs.length > 0);
	const hasTargetOrgs = $derived(targetOrgs.length > 0);

	// ── Single-mode fields ──────────────────────────────────────────────────
	// `sourceRepo` (org/repo) is used when no source org is pre-configured;
	// otherwise the org comes from `sourceOrg` and the user types just the name.
	let sourceOrg = $state(page.data.formDefaults?.sourceOrgs?.[0] ?? '');
	let sourceRepo = $state('');
	let sourceRepoName = $state('');
	let targetRepo = $state('');
	// A single configured source org is shown as a name (not a dropdown); this
	// reveals a free-text input when the operator chooses to override it.
	const defaultSourceOrg = $derived(page.data.formDefaults?.sourceOrgs?.[0] ?? '');
	const singleSourceOrg = $derived(sourceOrgs.length === 1);
	let overrideSourceOrg = $state(false);

	// ── Batch-mode fields ───────────────────────────────────────────────────
	let repoInput = $state('');
	let dragOver = $state(false);

	const parsedRepos = $derived(
		repoInput
			.split(/[\n,]+/)
			.map((r) => r.trim())
			.filter((r) => r.length > 0)
	);
	// When a source org is selected, bare names (no slash) belong to that org;
	// lines already in org/repo form pass through unchanged.
	const normalizedRepos = $derived(
		hasSourceOrgs && sourceOrg
			? parsedRepos.map((r) => (r.includes('/') ? r : `${sourceOrg}/${r}`))
			: parsedRepos
	);
	const validRepos = $derived(normalizedRepos.filter((r) => r.includes('/')));
	const invalidRepos = $derived(normalizedRepos.filter((r) => !r.includes('/')));

	// ── Shared fields ───────────────────────────────────────────────────────
	const defaultSourceApiUrl = $derived(page.data.formDefaults?.sourceApiUrl ?? '');
	let sourceApiUrl = $state(page.data.formDefaults?.sourceApiUrl ?? '');
	// The source is always shown as a resolved name; this reveals the URL input.
	let overrideSourceUrl = $state(false);
	let targetOrg = $state(page.data.formDefaults?.targetOrgs?.[0] ?? '');
	// A single configured target org is shown as a name (not a dropdown); this
	// reveals a free-text input when the operator chooses to override it.
	const defaultTargetOrg = $derived(page.data.formDefaults?.targetOrgs?.[0] ?? '');
	const singleTargetOrg = $derived(targetOrgs.length === 1);
	let overrideTargetOrg = $state(false);
	let submitting = $state(false);
	let error = $state('');

	// ── Auth mode + options (shared with restart modals) ────────────────────
	const sourceEnvApp = $derived(page.data.sourceAuth?.mode === 'github-app');
	const targetEnvApp = $derived(page.data.targetAuth?.mode === 'github-app');
	const sourceEnvPat = $derived(!!page.data.sourceAuth?.hasEnvPat);
	const targetEnvPat = $derived(!!page.data.targetAuth?.hasEnvPat);
	// Admin flag: may the user override server-configured credentials/fields?
	const allowOverride = $derived(page.data.allowCredentialOverride ?? true);
	// Lock pre-configured fields to their server values when override is off.
	const sourceOrgLocked = $derived(!allowOverride && hasSourceOrgs);
	const targetOrgLocked = $derived(!allowOverride && hasTargetOrgs);

	// ── In-flight migration indicator ───────────────────────────────────────
	const activeMigrations = $derived(page.data.activeMigrations ?? 0);
	const maxConcurrent = $derived(page.data.maxConcurrent ?? 10);
	const atCapacity = $derived(activeMigrations >= maxConcurrent);

	const form = createMigrationForm(() => ({
		sourceEnvApp,
		sourceEnvPat,
		targetEnvApp,
		targetEnvPat,
	}));
	form.initAuthModes();

	// Whether each side is currently authenticated by the server's env creds —
	// drives the "Authenticated" badge shown in the section header.
	const sourceServerAuthed = $derived(
		(sourceEnvApp || sourceEnvPat) &&
			(form.state.sourceAuthMode === 'env-app' || form.state.sourceAuthMode === 'env-pat')
	);
	const targetServerAuthed = $derived(
		(targetEnvApp || targetEnvPat) &&
			(form.state.targetAuthMode === 'env-app' || form.state.targetAuthMode === 'env-pat')
	);

	// ── Derived ─────────────────────────────────────────────────────────────
	// The effective source platform: blank API URL → GitHub Enterprise Cloud,
	// otherwise GitHub Enterprise Server (with the entered host shown alongside).
	const sourceIsCloud = $derived(!sourceApiUrl.trim());
	const sourcePlatformLabel = $derived(
		sourceIsCloud ? 'GitHub Enterprise Cloud' : 'GitHub Enterprise Server'
	);
	const sourceHost = $derived.by(() => {
		const raw = sourceApiUrl.trim();
		if (!raw) return '';
		try {
			return new URL(raw).host;
		} catch {
			return raw;
		}
	});

	// The full source repo (org/repo), combining the org picker + name field
	// when a source org is pre-configured, else the single org/repo input.
	const effectiveSourceRepo = $derived(
		hasSourceOrgs ? `${sourceOrg}/${sourceRepoName.trim()}` : sourceRepo
	);
	// Just the repo name, used to default the target repo name.
	const sourceBareName = $derived(
		hasSourceOrgs
			? sourceRepoName.trim()
			: sourceRepo.includes('/')
				? (sourceRepo.split('/')[1] ?? '')
				: sourceRepo
	);
	const derivedTargetRepo = $derived(targetRepo || sourceBareName);

	// ── File drag/drop (batch) ──────────────────────────────────────────────
	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const file = e.dataTransfer?.files[0];
		if (file) readFile(file);
	}

	function handleFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) readFile(file);
	}

	function readFile(file: File) {
		const reader = new FileReader();
		reader.onload = () => {
			const text = reader.result as string;
			repoInput = repoInput ? `${repoInput}\n${text}` : text;
		};
		reader.readAsText(file);
	}

	// ── Submit ──────────────────────────────────────────────────────────────
	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = '';

		if (mode === 'batch' && validRepos.length === 0) {
			error = 'No valid repositories to migrate. Each line should be in org/repo format.';
			return;
		}

		submitting = true;

		try {
			const commonFields = {
				...form.buildPayload(),
				sourceApiUrl: sourceApiUrl || undefined,
			};

			if (mode === 'single') {
				const res = await fetch('/api/migrations', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						...commonFields,
						sourceRepo: effectiveSourceRepo,
						targetOrg,
						targetRepo: derivedTargetRepo
					})
				});

				if (!res.ok) {
					const data = await res.json();
					error = data.error || `HTTP ${res.status}`;
					return;
				}

				const migration = await res.json();
				goto(`/${migration.id}`);
			} else {
				const res = await fetch('/api/batches', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						...commonFields,
						repos: validRepos,
						targetOrg
					})
				});

				if (!res.ok) {
					const data = await res.json();
					error = data.error || `HTTP ${res.status}`;
					return;
				}

				const batch = await res.json();
				goto(`/batches/${batch.id}`);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Unknown error';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto max-w-2xl">
	<h1 class="flex items-center gap-2 text-2xl font-bold text-gray-50">
		<Octicon name={mode === 'single' ? 'plus-circle' : 'stack'} size={24} />
		New Migration
	</h1>
	<p class="mt-1 text-sm text-gray-400">Migrate repositories from GHES or GHEC to GitHub Enterprise Cloud.</p>

	{#if activeMigrations > 0}
		<div class="mt-4 flex items-start gap-2 rounded-md border px-4 py-3 text-sm {atCapacity ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-blue-500/20 bg-blue-500/5 text-gray-300'}">
			<Octicon name={atCapacity ? 'hourglass' : 'sync'} size={16} class="mt-0.5 shrink-0 {atCapacity ? 'text-amber-400' : 'text-blue-400'}" />
			<div class="min-w-0">
				{#if atCapacity}
					<p>All {maxConcurrent} migration slots are in use ({activeMigrations} in process). New migrations are <span class="font-medium">queued automatically</span> and start as slots free up.</p>
				{:else}
					<p><span class="font-medium">{activeMigrations}</span> of {maxConcurrent} migration{activeMigrations === 1 ? '' : 's'} currently in process. Up to {maxConcurrent} run at once; anything beyond that queues automatically.</p>
				{/if}
			</div>
		</div>
	{/if}

	{#if error}
		<div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
			{error}
		</div>
	{/if}

	{#snippet authBadge(isApp: boolean)}
		<span
			class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-400"
			title={isApp
				? "Using the server's configured GitHub App — no credentials needed."
				: "Using the server's configured token — no credentials needed."}
		>
			<Octicon name="shield-check" size={12} />
			Authenticated
		</span>
	{/snippet}

	{#snippet orgNamePanel(label: string, hint: string, org: string, onOverride: () => void)}
		<div>
			<span class="block text-sm font-medium text-gray-400">
				{label}{#if hint}<span class="text-gray-600 ml-1">{hint}</span>{/if}
			</span>
			<div class="mt-1 flex items-center justify-between gap-3 rounded-md border border-blue-500/20 bg-blue-500/5 px-4 py-2.5">
				<span class="inline-flex min-w-0 items-center gap-2 text-sm">
					<Octicon name="organization" size={16} class="shrink-0 text-blue-400" />
					<span class="truncate font-mono text-gray-100">{org}</span>
				</span>
				{#if allowOverride}
					<button type="button" onclick={onOverride}
						class="shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
						Change
					</button>
				{/if}
			</div>
		</div>
	{/snippet}

	<form class="mt-6 space-y-6" onsubmit={handleSubmit}>
		<!-- Repositories -->
		<div class="space-y-4 rounded-md border border-gray-700 bg-gray-900 p-5">
			<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300">
				<Octicon name="repo" size={16} />Repositories
			</h3>

			<!-- Mode toggle -->
			<div class="grid grid-cols-2 gap-2">
				<button type="button" aria-pressed={mode === 'single'}
					class="flex items-start gap-2.5 rounded-md border p-3 text-left transition-colors {mode === 'single' ? 'border-blue-500/50 bg-blue-500/10' : 'border-gray-700 bg-gray-800/40 hover:border-gray-600 hover:bg-gray-800'}"
					onclick={() => mode = 'single'}>
					<Octicon name="repo" size={16} class="mt-0.5 shrink-0 {mode === 'single' ? 'text-blue-400' : 'text-gray-500'}" />
					<span class="min-w-0">
						<span class="block text-sm font-medium {mode === 'single' ? 'text-gray-50' : 'text-gray-300'}">Single Repo</span>
						<span class="block text-xs text-gray-500">Migrate one repository</span>
					</span>
				</button>
				<button type="button" aria-pressed={mode === 'batch'}
					class="flex items-start gap-2.5 rounded-md border p-3 text-left transition-colors {mode === 'batch' ? 'border-blue-500/50 bg-blue-500/10' : 'border-gray-700 bg-gray-800/40 hover:border-gray-600 hover:bg-gray-800'}"
					onclick={() => mode = 'batch'}>
					<Octicon name="stack" size={16} class="mt-0.5 shrink-0 {mode === 'batch' ? 'text-blue-400' : 'text-gray-500'}" />
					<span class="min-w-0">
						<span class="block text-sm font-medium {mode === 'batch' ? 'text-gray-50' : 'text-gray-300'}">Batch</span>
						<span class="block text-xs text-gray-500">Migrate many at once</span>
					</span>
				</button>
			</div>

			{#if mode === 'single'}
				{#if hasSourceOrgs && singleSourceOrg}
					<!-- Single configured source org: name (default) or input (override). -->
					{#if overrideSourceOrg}
						<div>
							<div class="flex items-center justify-between gap-2">
								<label for="sourceOrg" class="block text-sm font-medium text-gray-400">
									Source Org <span class="text-red-400">*</span>
								</label>
								<button type="button" onclick={() => { sourceOrg = defaultSourceOrg; overrideSourceOrg = false; }}
									class="shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
									Cancel
								</button>
							</div>
							<input id="sourceOrg" type="text" required bind:value={sourceOrg}
								placeholder="org"
								class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
						</div>
					{:else}
						{@render orgNamePanel('Source Org', '', sourceOrg, () => (overrideSourceOrg = true))}
					{/if}
					<div>
						<label for="sourceRepoName" class="block text-sm font-medium text-gray-400">
							Repository Name <span class="text-red-400">*</span>
						</label>
						<input id="sourceRepoName" type="text" required bind:value={sourceRepoName}
							placeholder="repo"
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					</div>
				{:else if hasSourceOrgs}
					<!-- Multiple configured orgs: dropdown beside the repo name. -->
					<div class="flex gap-2">
						<div class="w-2/5">
							<label for="sourceOrg" class="block text-sm font-medium text-gray-400">
								Source Org <span class="text-red-400">*</span>
							</label>
							<OrgSelect id="sourceOrg" bind:value={sourceOrg} options={sourceOrgs}
								locked={sourceOrgLocked} required placeholder="org" />
						</div>
						<div class="flex-1">
							<label for="sourceRepoName" class="block text-sm font-medium text-gray-400">
								Repository Name <span class="text-red-400">*</span>
							</label>
							<input id="sourceRepoName" type="text" required bind:value={sourceRepoName}
								placeholder="repo"
								class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
						</div>
					</div>
				{:else}
					<div>
						<label for="sourceRepo" class="block text-sm font-medium text-gray-400">
							Source Repository <span class="text-red-400">*</span>
						</label>
						<input id="sourceRepo" type="text" required bind:value={sourceRepo}
							placeholder="org/repo"
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					</div>
				{/if}
			{:else}
				{#if hasSourceOrgs && singleSourceOrg && !overrideSourceOrg}
					{@render orgNamePanel('Source Org', 'applied to names without an org/', sourceOrg, () => (overrideSourceOrg = true))}
				{:else if hasSourceOrgs}
					<div>
						<div class="flex items-center justify-between gap-2">
							<label for="batchSourceOrg" class="block text-sm font-medium text-gray-400">
								Source Org <span class="text-red-400">*</span>
								<span class="text-gray-600 ml-1">applied to names without an org/</span>
							</label>
							{#if singleSourceOrg && overrideSourceOrg}
								<button type="button" onclick={() => { sourceOrg = defaultSourceOrg; overrideSourceOrg = false; }}
									class="shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
									Cancel
								</button>
							{/if}
						</div>
						{#if singleSourceOrg && overrideSourceOrg}
							<input id="batchSourceOrg" type="text" required bind:value={sourceOrg}
								placeholder="org"
								class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
						{:else}
							<OrgSelect id="batchSourceOrg" bind:value={sourceOrg} options={sourceOrgs}
								locked={sourceOrgLocked} required placeholder="org" />
						{/if}
					</div>
				{/if}
				<div>
					<label for="repoInput" class="block text-sm font-medium text-gray-400">
						Repository List <span class="text-red-400">*</span>
						<span class="text-gray-600 ml-1">{hasSourceOrgs ? 'one per line; bare name or org/repo' : 'one per line, org/repo format'}</span>
					</label>
					<textarea id="repoInput" required bind:value={repoInput} rows="6"
						placeholder={hasSourceOrgs ? "api-server\nweb-frontend\nshared-libs" : "acme-corp/api-server\nacme-corp/web-frontend\nacme-corp/shared-libs"}
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"></textarea>
				</div>

				<!-- File upload / drag-drop -->
				<div
					class="rounded-md border-2 border-dashed p-4 text-center text-sm transition-colors
						{dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-gray-700'}"
					role="button"
					tabindex="0"
					ondragover={(e) => { e.preventDefault(); dragOver = true; }}
					ondragleave={() => dragOver = false}
					ondrop={handleDrop}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget.querySelector('input[type="file"]') as HTMLElement)?.click(); } }}
				>
					<div class="flex items-center justify-center gap-1.5 text-gray-400">
						<Octicon name="upload" size={16} />
						<span>Drag a CSV or text file here, or</span>
						<label class="cursor-pointer text-blue-400 hover:text-blue-300">
							browse
							<input type="file" accept=".csv,.txt,.text" class="hidden" onchange={handleFileInput} />
						</label>
					</div>
				</div>

				<!-- Repo count summary -->
				{#if parsedRepos.length > 0}
					<div class="flex items-center gap-4 text-sm">
						<span class="text-green-400">{validRepos.length} valid</span>
						{#if invalidRepos.length > 0}
							<span class="text-red-400">{invalidRepos.length} invalid: {invalidRepos.join(', ')}</span>
						{/if}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Source -->
		<div class="space-y-4 rounded-md border border-gray-700 bg-gray-900 p-5">
			<div class="flex items-center justify-between gap-2">
				<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300"><Octicon name="server" size={16} />Source</h3>
				{#if sourceServerAuthed}{@render authBadge(sourceEnvApp)}{/if}
			</div>

			{#if overrideSourceUrl}
				<div>
					<div class="flex items-center justify-between gap-2">
						<label for="sourceApiUrl" class="block text-sm font-medium text-gray-400">
							Source API URL
							<span class="text-gray-600">(blank = GitHub Enterprise Cloud)</span>
						</label>
						<button type="button" onclick={() => { sourceApiUrl = defaultSourceApiUrl; overrideSourceUrl = false; }}
							class="shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
							Cancel
						</button>
					</div>
					<input id="sourceApiUrl" type="url" bind:value={sourceApiUrl}
						placeholder="https://ghes.example.com"
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					<p class="mt-2 inline-flex items-center gap-1.5 text-xs text-gray-500">
						<Octicon name={sourceIsCloud ? 'cloud' : 'server'} size={12} class="text-blue-400" />
						{sourcePlatformLabel}
						{#if !sourceIsCloud && sourceHost}<span class="font-mono text-gray-400">{sourceHost}</span>{/if}
					</p>
				</div>
			{:else}
				<!-- Resolved source: platform name + icon (host shown for GHES). -->
				<div class="flex items-center justify-between gap-3 rounded-md border border-blue-500/20 bg-blue-500/5 px-4 py-3">
					<span class="inline-flex min-w-0 items-center gap-2 text-sm">
						<Octicon name={sourceIsCloud ? 'cloud' : 'server'} size={16} class="shrink-0 text-blue-400" />
						<span class="truncate text-gray-100">{sourcePlatformLabel}</span>
						{#if !sourceIsCloud && sourceHost}<span class="truncate font-mono text-xs text-gray-500">{sourceHost}</span>{/if}
					</span>
					{#if allowOverride}
						<button type="button" onclick={() => (overrideSourceUrl = true)}
							class="shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
							Change
						</button>
					{/if}
				</div>
			{/if}

			<AuthModeFields
				variant="inline"
				required
				serverBadgeInHeader
				envApp={sourceEnvApp}
				envPat={sourceEnvPat}
				allowOverride={allowOverride}
				bind:mode={form.state.sourceAuthMode}
				bind:token={form.state.sourceToken}
				bind:appId={form.state.sourceAppId}
				bind:installationId={form.state.sourceAppInstallationId}
				bind:appKey={form.state.sourceAppKey}
			/>
		</div>
		<div class="space-y-4 rounded-md border border-gray-700 bg-gray-900 p-5">
			<div class="flex items-center justify-between gap-2">
				<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300"><Octicon name="repo-push" size={16} />Target</h3>
				{#if targetServerAuthed}{@render authBadge(targetEnvApp)}{/if}
			</div>

			{#if hasTargetOrgs && singleTargetOrg && !overrideTargetOrg}
				<!-- Single configured org: show the name, not a dropdown. -->
				{@render orgNamePanel('Target Organization', '', targetOrg, () => (overrideTargetOrg = true))}
			{:else}
				<div>
					<div class="flex items-center justify-between gap-2">
						<label for="targetOrg" class="block text-sm font-medium text-gray-400">
							Target Organization <span class="text-red-400">*</span>
						</label>
						{#if hasTargetOrgs && overrideTargetOrg}
							<button type="button" onclick={() => { targetOrg = defaultTargetOrg; overrideTargetOrg = false; }}
								class="shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
								Cancel
							</button>
						{/if}
					</div>
					{#if hasTargetOrgs && !overrideTargetOrg}
						<OrgSelect id="targetOrg" bind:value={targetOrg} options={targetOrgs}
							locked={targetOrgLocked} required placeholder="my-ghec-org" />
					{:else}
						<input id="targetOrg" type="text" required bind:value={targetOrg}
							placeholder="my-ghec-org"
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					{/if}
				</div>
			{/if}

			{#if mode === 'single'}
				<div>
					<label for="targetRepo" class="block text-sm font-medium text-gray-400">
						Target Repository Name
						<span class="text-gray-600">(defaults to source repo name)</span>
					</label>
					<input id="targetRepo" type="text" bind:value={targetRepo}
						placeholder={sourceBareName || 'repo'}
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
				</div>
			{/if}

			<AuthModeFields
				variant="inline"
				required
				serverBadgeInHeader
				envApp={targetEnvApp}
				envPat={targetEnvPat}
				allowOverride={allowOverride}
				bind:mode={form.state.targetAuthMode}
				bind:token={form.state.targetToken}
				bind:appId={form.state.targetAppId}
				bind:installationId={form.state.targetAppInstallationId}
				bind:appKey={form.state.targetAppKey}
			/>

			<div>
				<label for="visibility" class="block text-sm font-medium text-gray-400">
					Repository Visibility
					<span class="text-gray-600">(optional{mode === 'batch' ? ', applies to all repos' : ''})</span>
				</label>
				<select id="visibility" bind:value={form.state.targetRepoVisibility}
					class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
					<option value="">Default</option>
					<option value="private">Private</option>
					<option value="public">Public</option>
					<option value="internal">Internal</option>
				</select>
			</div>
		</div>

		<!-- Options -->
		<div class="space-y-3 rounded-md border border-gray-700 bg-gray-900 p-5">
			<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300"><Octicon name="gear" size={16} />Options</h3>

			<!-- Migration Mode toggle -->
			<div>
				<span class="block text-sm font-medium text-gray-400 mb-1.5">Migration Mode</span>
				<div class="grid grid-cols-2 gap-2">
					<button type="button" aria-pressed={form.state.migrationMode === 'dry-run'}
						class="flex items-start gap-2.5 rounded-md border p-3 text-left transition-colors {form.state.migrationMode === 'dry-run' ? 'border-blue-500/50 bg-blue-500/10' : 'border-gray-700 bg-gray-800/40 hover:border-gray-600 hover:bg-gray-800'}"
						onclick={() => form.state.migrationMode = 'dry-run'}>
						<Octicon name="beaker" size={16} class="mt-0.5 shrink-0 {form.state.migrationMode === 'dry-run' ? 'text-blue-400' : 'text-gray-500'}" />
						<span class="min-w-0">
							<span class="block text-sm font-medium {form.state.migrationMode === 'dry-run' ? 'text-gray-50' : 'text-gray-300'}">Dry Run</span>
							<span class="block text-xs text-gray-500">Test without locking the source</span>
						</span>
					</button>
					<button type="button" aria-pressed={form.state.migrationMode === 'production'}
						class="flex items-start gap-2.5 rounded-md border p-3 text-left transition-colors {form.state.migrationMode === 'production' ? 'border-amber-500/50 bg-amber-500/10' : 'border-gray-700 bg-gray-800/40 hover:border-gray-600 hover:bg-gray-800'}"
						onclick={() => form.state.migrationMode = 'production'}>
						<Octicon name="rocket" size={16} class="mt-0.5 shrink-0 {form.state.migrationMode === 'production' ? 'text-amber-400' : 'text-gray-500'}" />
						<span class="min-w-0">
							<span class="block text-sm font-medium {form.state.migrationMode === 'production' ? 'text-gray-50' : 'text-gray-300'}">Production</span>
							<span class="block text-xs text-gray-500">Lock &amp; archive the source</span>
						</span>
					</button>
				</div>
				{#if form.state.migrationMode === 'production'}
					<div class="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
						<Octicon name="alert" size={12} class="shrink-0" />
						Source {mode === 'batch' ? 'repositories' : 'repository'} will be locked during migration and archived (read-only) after success.
					</div>
				{/if}
			</div>

			<label class="flex cursor-pointer items-center gap-3 rounded-md border border-gray-700 bg-gray-800/40 px-3 py-2.5 transition-colors hover:border-gray-600">
				<Octicon name="tag" size={16} class="shrink-0 text-gray-500" />
				<span class="min-w-0 flex-1">
					<span class="block text-sm text-gray-300">Skip releases</span>
					<span class="block text-xs text-gray-500">Don&rsquo;t migrate GitHub releases</span>
				</span>
				<input type="checkbox" bind:checked={form.state.skipReleases}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500" />
			</label>

			<label class="flex cursor-pointer items-center gap-3 rounded-md border border-gray-700 bg-gray-800/40 px-3 py-2.5 transition-colors hover:border-gray-600">
				<Octicon name="arrow-switch" size={16} class="shrink-0 text-gray-500" />
				<span class="min-w-0 flex-1">
					<span class="block text-sm text-gray-300">Direct passthrough</span>
					<span class="block text-xs text-gray-500">Stream between hosts, skipping download/upload</span>
				</span>
				<input type="checkbox" bind:checked={form.state.directPassthrough}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500" />
			</label>

			<label class="flex cursor-pointer items-center gap-3 rounded-md border border-gray-700 bg-gray-800/40 px-3 py-2.5 transition-colors hover:border-gray-600">
				<Octicon name="shield-slash" size={16} class="shrink-0 text-gray-500" />
				<span class="min-w-0 flex-1">
					<span class="block text-sm text-gray-300">Skip SSL verification</span>
					<span class="block text-xs text-gray-500">Allow self-signed certificates</span>
				</span>
				<input type="checkbox" bind:checked={form.state.noSslVerify}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500" />
			</label>
		</div>

		<!-- Submit -->
		<div class="flex items-center justify-between">
			{#if mode === 'batch'}
				<span class="text-sm text-gray-500">
					{validRepos.length} {validRepos.length === 1 ? 'repository' : 'repositories'} will be migrated
				</span>
			{:else}
				<span></span>
			{/if}
			<div class="flex items-center gap-3">
				<a href="/" class="text-sm text-gray-400 hover:text-gray-50 transition-colors">Cancel</a>
				<button type="submit" disabled={submitting || (mode === 'batch' && validRepos.length === 0)}
					class="flex items-center gap-1.5 rounded-md bg-green-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
					{#if submitting}
						Starting...
					{:else}
						<Octicon name="rocket" size={16} />
						{mode === 'single' ? 'Start Migration' : `Start ${validRepos.length} Migrations`}
					{/if}
				</button>
			</div>
		</div>
	</form>
</div>
