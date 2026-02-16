<!-- New migration form — single or batch -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import Octicon from '$lib/components/Octicon.svelte';
	import type { AppAuth } from '$lib/types';

	let mode = $state<'single' | 'batch'>('single');

	// ── Single-mode fields ──────────────────────────────────────────────────
	let sourceRepo = $state('');
	let targetRepo = $state('');

	// ── Batch-mode fields ───────────────────────────────────────────────────
	let repoInput = $state('');
	let dragOver = $state(false);

	const parsedRepos = $derived(
		repoInput
			.split(/[\n,]+/)
			.map((r) => r.trim())
			.filter((r) => r.length > 0)
	);
	const validRepos = $derived(parsedRepos.filter((r) => r.includes('/')));
	const invalidRepos = $derived(parsedRepos.filter((r) => !r.includes('/')));

	// ── Shared fields ───────────────────────────────────────────────────────
	let sourceApiUrl = $state('');
	let targetOrg = $state('');
	let sourceToken = $state('');
	let targetToken = $state('');
	let skipReleases = $state(false);
	let migrationMode = $state<'dry-run' | 'production'>('dry-run');
	let directPassthrough = $state(false);
	let targetRepoVisibility = $state('');
	let noSslVerify = $state(false);
	let submitting = $state(false);
	let error = $state('');

	// ── Auth mode ───────────────────────────────────────────────────────────
	const sourceEnvApp = $derived(page.data.sourceAuth?.mode === 'github-app');
	const targetEnvApp = $derived(page.data.targetAuth?.mode === 'github-app');
	const sourceEnvPat = $derived(!!page.data.sourceAuth?.hasEnvPat);
	const targetEnvPat = $derived(!!page.data.targetAuth?.hasEnvPat);

	let sourceAuthMode = $state<'pat' | 'app' | 'env-app' | 'env-pat'>(
		untrack(() => sourceEnvApp) ? 'env-app' : untrack(() => sourceEnvPat) ? 'env-pat' : 'pat'
	);
	let targetAuthMode = $state<'pat' | 'app' | 'env-app' | 'env-pat'>(
		untrack(() => targetEnvApp) ? 'env-app' : untrack(() => targetEnvPat) ? 'env-pat' : 'pat'
	);

	let sourceAppId = $state('');
	let sourceAppKey = $state('');
	let sourceAppInstallationId = $state('');
	let targetAppId = $state('');
	let targetAppKey = $state('');
	let targetAppInstallationId = $state('');

	// ── Derived ─────────────────────────────────────────────────────────────
	const derivedTargetRepo = $derived(
		targetRepo || (sourceRepo.includes('/') ? sourceRepo.split('/')[1] : sourceRepo)
	);

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
			repoInput = repoInput ? repoInput + '\n' + text : text;
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
			const sourceApp: AppAuth | undefined =
				sourceAuthMode === 'app'
					? { appId: sourceAppId, privateKey: sourceAppKey, installationId: sourceAppInstallationId }
					: undefined;
			const targetApp: AppAuth | undefined =
				targetAuthMode === 'app'
					? { appId: targetAppId, privateKey: targetAppKey, installationId: targetAppInstallationId }
					: undefined;

			const commonFields = {
				sourceApiUrl: sourceApiUrl || undefined,
				sourceToken: sourceAuthMode === 'pat' ? sourceToken || undefined : undefined,
				targetToken: targetAuthMode === 'pat' ? targetToken || undefined : undefined,
				sourceApp,
				targetApp,
				skipReleases,
				lockSource: migrationMode === 'production',
				archiveSource: migrationMode === 'production',
				directPassthrough,
				targetRepoVisibility: targetRepoVisibility || undefined,
				noSslVerify
			};

			if (mode === 'single') {
				const res = await fetch('/api/migrations', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						...commonFields,
						sourceRepo,
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

	{#if error}
		<div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
			{error}
		</div>
	{/if}

	<form class="mt-6 space-y-6" onsubmit={handleSubmit}>
		<!-- Repositories -->
		<div class="space-y-4 rounded-md border border-gray-700 bg-gray-900 p-5">
			<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300">
				<Octicon name="repo" size={16} />Repositories
			</h3>

			<!-- Mode toggle -->
			<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
				<button type="button"
					class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'single' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
					onclick={() => mode = 'single'}>
					Single Repo
				</button>
				<button type="button"
					class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {mode === 'batch' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
					onclick={() => mode = 'batch'}>
					Batch
				</button>
			</div>

			{#if mode === 'single'}
				<div>
					<label for="sourceRepo" class="block text-sm font-medium text-gray-400">
						Source Repository <span class="text-red-400">*</span>
					</label>
					<input id="sourceRepo" type="text" required bind:value={sourceRepo}
						placeholder="org/repo"
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
				</div>
			{:else}
				<div>
					<label for="repoInput" class="block text-sm font-medium text-gray-400">
						Repository List <span class="text-red-400">*</span>
						<span class="text-gray-600 ml-1">one per line, org/repo format</span>
					</label>
					<textarea id="repoInput" required bind:value={repoInput} rows="6"
						placeholder={"acme-corp/api-server\nacme-corp/web-frontend\nacme-corp/shared-libs"}
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
			<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300"><Octicon name="server" size={16} />Source</h3>

			<div>
				<label for="sourceApiUrl" class="block text-sm font-medium text-gray-400">
					Source API URL
					<span class="text-gray-600">(leave blank for github.com)</span>
				</label>
				<input id="sourceApiUrl" type="url" bind:value={sourceApiUrl}
					placeholder="https://ghes.example.com"
					class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
			</div>

			<!-- Auth mode toggle -->
			<div>
				<span class="block text-sm font-medium text-gray-400 mb-2">Authentication</span>
				<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
					<button type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {sourceAuthMode === 'pat' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
						onclick={() => sourceAuthMode = 'pat'}>
						PAT
					</button>
					<button type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {sourceAuthMode === 'app' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
						onclick={() => sourceAuthMode = 'app'}>
						GitHub App
					</button>
					{#if sourceEnvApp}
						<button type="button"
							class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {sourceAuthMode === 'env-app' ? 'bg-blue-600/30 text-blue-400' : 'text-gray-400 hover:text-gray-200'}"
							onclick={() => sourceAuthMode = 'env-app'}>
							Env App
						</button>
					{/if}
					{#if sourceEnvPat}
						<button type="button"
							class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {sourceAuthMode === 'env-pat' ? 'bg-blue-600/30 text-blue-400' : 'text-gray-400 hover:text-gray-200'}"
							onclick={() => sourceAuthMode = 'env-pat'}>
							Env PAT
						</button>
					{/if}
				</div>
			</div>

			{#if sourceAuthMode === 'pat'}
				<div>
					<label for="sourceToken" class="block text-sm font-medium text-gray-400">
						Source PAT <span class="text-red-400">*</span>
					</label>
					<input id="sourceToken" type="password" required bind:value={sourceToken}
						placeholder="ghp_..."
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
				</div>
			{:else if sourceAuthMode === 'app'}
				<div class="space-y-3 rounded-md border border-gray-700/50 bg-gray-800/50 p-4">
					<div>
						<label for="sourceAppId" class="block text-sm font-medium text-gray-400">App ID <span class="text-red-400">*</span></label>
						<input id="sourceAppId" type="text" required bind:value={sourceAppId}
							placeholder="123456"
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					</div>
					<div>
						<label for="sourceAppInstallationId" class="block text-sm font-medium text-gray-400">Installation ID <span class="text-red-400">*</span></label>
						<input id="sourceAppInstallationId" type="text" required bind:value={sourceAppInstallationId}
							placeholder="12345678"
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					</div>
					<div>
						<label for="sourceAppKey" class="block text-sm font-medium text-gray-400">Private Key (PEM) <span class="text-red-400">*</span></label>
						<textarea id="sourceAppKey" required bind:value={sourceAppKey} rows="4"
							placeholder={"-----BEGIN RSA PRIVATE KEY-----\n..."}
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"></textarea>
					</div>
				</div>
			{:else if sourceAuthMode === 'env-app'}
				<p class="text-xs text-blue-400/80">Using server-configured GitHub App (App ID: {page.data.sourceAuth?.appId ?? '—'}).</p>
			{:else}
				<p class="text-xs text-blue-400/80">Using server-configured PAT (GH_SOURCE_PAT).</p>
			{/if}
		</div>
		<div class="space-y-4 rounded-md border border-gray-700 bg-gray-900 p-5">
			<h3 class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-300"><Octicon name="repo-push" size={16} />Target</h3>

			<div>
				<label for="targetOrg" class="block text-sm font-medium text-gray-400">
					Target Organization <span class="text-red-400">*</span>
				</label>
				<input id="targetOrg" type="text" required bind:value={targetOrg}
					placeholder="my-ghec-org"
					class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
			</div>

			{#if mode === 'single'}
				<div>
					<label for="targetRepo" class="block text-sm font-medium text-gray-400">
						Target Repository Name
						<span class="text-gray-600">(defaults to source repo name)</span>
					</label>
					<input id="targetRepo" type="text" bind:value={targetRepo}
						placeholder={sourceRepo.includes('/') ? sourceRepo.split('/')[1] : sourceRepo || 'repo'}
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
				</div>
			{/if}

			<!-- Auth mode toggle -->
			<div>
				<span class="block text-sm font-medium text-gray-400 mb-2">Authentication</span>
				<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
					<button type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {targetAuthMode === 'pat' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
						onclick={() => targetAuthMode = 'pat'}>
						PAT
					</button>
					<button type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {targetAuthMode === 'app' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
						onclick={() => targetAuthMode = 'app'}>
						GitHub App
					</button>
					{#if targetEnvApp}
						<button type="button"
							class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {targetAuthMode === 'env-app' ? 'bg-blue-600/30 text-blue-400' : 'text-gray-400 hover:text-gray-200'}"
							onclick={() => targetAuthMode = 'env-app'}>
							Env App
						</button>
					{/if}
					{#if targetEnvPat}
						<button type="button"
							class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {targetAuthMode === 'env-pat' ? 'bg-blue-600/30 text-blue-400' : 'text-gray-400 hover:text-gray-200'}"
							onclick={() => targetAuthMode = 'env-pat'}>
							Env PAT
						</button>
					{/if}
				</div>
			</div>

			{#if targetAuthMode === 'pat'}
				<div>
					<label for="targetToken" class="block text-sm font-medium text-gray-400">
						Target PAT <span class="text-red-400">*</span>
					</label>
					<input id="targetToken" type="password" required bind:value={targetToken}
						placeholder="ghp_..."
						class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
				</div>
			{:else if targetAuthMode === 'app'}
				<div class="space-y-3 rounded-md border border-gray-700/50 bg-gray-800/50 p-4">
					<div>
						<label for="targetAppId" class="block text-sm font-medium text-gray-400">App ID <span class="text-red-400">*</span></label>
						<input id="targetAppId" type="text" required bind:value={targetAppId}
							placeholder="123456"
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					</div>
					<div>
						<label for="targetAppInstallationId" class="block text-sm font-medium text-gray-400">Installation ID <span class="text-red-400">*</span></label>
						<input id="targetAppInstallationId" type="text" required bind:value={targetAppInstallationId}
							placeholder="12345678"
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
					</div>
					<div>
						<label for="targetAppKey" class="block text-sm font-medium text-gray-400">Private Key (PEM) <span class="text-red-400">*</span></label>
						<textarea id="targetAppKey" required bind:value={targetAppKey} rows="4"
							placeholder={"-----BEGIN RSA PRIVATE KEY-----\n..."}
							class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"></textarea>
					</div>
				</div>
			{:else if targetAuthMode === 'env-app'}
				<p class="text-xs text-blue-400/80">Using server-configured GitHub App (App ID: {page.data.targetAuth?.appId ?? '—'}).</p>
			{:else}
				<p class="text-xs text-blue-400/80">Using server-configured PAT (GH_TARGET_PAT).</p>
			{/if}

			<div>
				<label for="visibility" class="block text-sm font-medium text-gray-400">
					Repository Visibility
					<span class="text-gray-600">(optional{mode === 'batch' ? ', applies to all repos' : ''})</span>
				</label>
				<select id="visibility" bind:value={targetRepoVisibility}
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
				<div class="flex gap-1 rounded-md bg-gray-800 p-0.5">
					<button type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {migrationMode === 'dry-run' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"
						onclick={() => migrationMode = 'dry-run'}>
						Dry Run
					</button>
					<button type="button"
						class="flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors {migrationMode === 'production' ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-gray-200'}"
						onclick={() => migrationMode = 'production'}>
						Production
					</button>
				</div>
				{#if migrationMode === 'production'}
					<div class="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
						<Octicon name="alert" size={12} class="shrink-0" />
						Source {mode === 'batch' ? 'repositories' : 'repository'} will be locked during migration and archived (read-only) after success.
					</div>
				{/if}
			</div>

			<label class="flex items-center gap-3">
				<input type="checkbox" bind:checked={skipReleases}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500" />
				<span class="text-sm text-gray-400">Skip releases</span>
			</label>

			<label class="flex items-center gap-3">
				<input type="checkbox" bind:checked={directPassthrough}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500" />
				<span class="text-sm text-gray-400">Direct passthrough (skip download/upload)</span>
			</label>

			<label class="flex items-center gap-3">
				<input type="checkbox" bind:checked={noSslVerify}
					class="rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500" />
				<span class="text-sm text-gray-400">Skip SSL verification (self-signed certs)</span>
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
