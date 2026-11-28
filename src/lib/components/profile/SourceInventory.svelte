<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import type { UsedIconName } from "$lib/icons.generated";
	import type { ProfileInventoryMetricKey, ProfileInventorySummary } from "$lib/profile/types";
	import { GITLAB_PROFILE_METRIC_CARDS, GITLAB_PROTECTION_RULE_METRIC_KEYS } from "$lib/source/gitlab-metrics";
	import type { NumericObservation } from "$lib/source/types";

	const VISIBILITIES = ["private", "internal", "public"] as const;
	interface MetricTile {
		key: ProfileInventoryMetricKey;
		label: string;
		icon: UsedIconName;
		position: number;
	}
	// GitLab cards come from the metric registry; Bitbucket adds the two it alone reports.
	const PROFILE_METRIC_TILES = (
		[
			...GITLAB_PROFILE_METRIC_CARDS,
			{ key: "pullRequests", label: "Pull requests", icon: "git-pull-request", position: 1.5 },
			{ key: "forks", label: "Forks", icon: "repo-forked", position: 6 },
		] satisfies MetricTile[]
	).sort((left, right) => left.position - right.position);

	let {
		providerName,
		bitbucket = false,
		profileId,
		running,
		progress,
		summary,
	}: {
		providerName: string;
		bitbucket?: boolean;
		profileId?: string;
		running: boolean;
		progress: { discovered: number; page: number } | null;
		summary: ProfileInventorySummary | null;
	} = $props();

	function formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const units = ["B", "KiB", "MiB", "GiB", "TiB"];
		const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
		const value = bytes / 1024 ** unit;
		return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
	}

	function formatObservation(
		observation: NumericObservation,
		format: (value: number) => string = (value) => value.toLocaleString(),
	): string {
		if (observation.kind === "unavailable") return "Unavailable";
		const value = format(observation.value);
		return observation.kind === "at-least" ? `At least ${value}` : value;
	}

	const storageTiles = $derived(
		summary
			? [
					{ label: "Repository data", value: summary.storage.repositorySizeBytes, icon: "repo" },
					...(bitbucket ? [] : [
					{ label: "Total storage", value: summary.storage.storageSizeBytes, icon: "database" },
					{ label: "LFS objects", value: summary.storage.lfsObjectsSizeBytes, icon: "file-binary" },
					{ label: "Packages", value: summary.storage.packagesSizeBytes, icon: "package" },
					{ label: "Wikis", value: summary.storage.wikiSizeBytes, icon: "book" },
					{ label: "Job artifacts", value: summary.storage.jobArtifactsSizeBytes, icon: "package" },
					{ label: "Pipeline artifacts", value: summary.storage.pipelineArtifactsSizeBytes, icon: "package" },
					{ label: "Snippets", value: summary.storage.snippetsSizeBytes, icon: "file-binary" },
					{ label: "Container registry", value: summary.storage.containerRegistrySizeBytes, icon: "database" },
					] as const),
					{ label: bitbucket ? "Attachments" : "Uploads", value: summary.storage.uploadsSizeBytes, icon: "upload" },
				] satisfies Array<{ label: string; value: NumericObservation; icon: UsedIconName }>
			: [],
	);
	const unavailableStorageMetrics = $derived(
		storageTiles.filter((tile) => tile.value.kind === "unavailable").length,
	);
	const profileMetricTiles = $derived(
		summary?.metrics
			? PROFILE_METRIC_TILES.flatMap((tile) => {
					const value = summary.metrics?.[tile.key];
					return value ? [{ ...tile, value }] : [];
				})
			: [],
	);
	// GitHub does not import GitLab protection rules, so every counted rule must be recreated.
	const protectionRulesToRecreate = $derived.by((): NumericObservation | null => {
		const observations = GITLAB_PROTECTION_RULE_METRIC_KEYS.map((key) => summary?.metrics?.[key]);
		if (!observations.every((observation) => observation !== undefined)) return null;
		const known = observations.filter((observation) => observation.kind !== "unavailable");
		if (known.length === 0) return observations[0] ?? null;
		const value = known.reduce((total, observation) => total + observation.value, 0);
		const exact = known.length === observations.length && known.every((observation) => observation.kind === "exact");
		return { kind: exact ? "exact" : "at-least", value };
	});
</script>

<section class="space-y-6" aria-label={`${providerName} source profile`}>
	{#if running}
		<div class="flex items-center gap-3 rounded-md border border-blue-500/25 bg-blue-500/10 p-4 text-sm text-blue-200" role="status" aria-live="polite">
			<Octicon name="sync" size={16} class="shrink-0 animate-spin" />
			<div>
				<p class="font-medium">Discovering {providerName} projects</p>
				<p class="mt-0.5 text-xs text-blue-200/70">
					{#if progress}
						{progress.discovered.toLocaleString()} discovered through page {progress.page.toLocaleString()}
					{:else}
						Waiting for source projects...
					{/if}
				</p>
			</div>
		</div>
	{/if}

	{#if summary}
		<div class="grid grid-cols-2 gap-3 {bitbucket ? 'sm:grid-cols-4' : 'sm:grid-cols-3 lg:grid-cols-5'}">
			<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
				<div class="text-2xl font-semibold text-gray-50">{formatObservation(summary.projectCount)}</div>
				<div class="mt-1 text-xs text-gray-400">{bitbucket ? "Repositories discovered" : "Projects discovered"}</div>
			</div>
			{#each VISIBILITIES.filter((visibility) => !bitbucket || visibility !== "internal") as visibility (visibility)}
				<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
					<div class="text-2xl font-semibold text-gray-50">{summary.visibility[visibility].toLocaleString()}</div>
					<div class="mt-1 text-xs capitalize text-gray-400">{visibility}</div>
				</div>
			{/each}
			<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
				<div class="text-2xl font-semibold {summary.archivedProjects > 0 ? 'text-amber-400' : 'text-gray-50'}">{summary.archivedProjects.toLocaleString()}</div>
				<div class="mt-1 text-xs text-gray-400">Archived</div>
			</div>
		</div>

		{#if profileMetricTiles.length > 0}
			<section>
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300"><Octicon name="repo" size={16} />Repository contents</h2>
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 {bitbucket ? 'lg:grid-cols-5' : 'lg:grid-cols-6'}">
					{#each profileMetricTiles as tile (tile.label)}
						<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
							<div class="text-lg font-semibold text-gray-50">{formatObservation(tile.value)}</div>
							<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400"><Octicon name={tile.icon} size={12} class="text-gray-500" />{tile.label}</div>
						</div>
					{/each}
				</div>
				{#if summary.approvalPolicy && summary.projectsCaptured > 0}
					{@const policy = summary.approvalPolicy}
					<p class="mt-3 text-[13px] text-[var(--workbench-text-muted)]">
						{#if policy.requiresApprovals === true}
							Required approvals were found in visible project rules.
							{#if policy.hasRequiredProtectedBranchRules === true}
								Some rules specifically target protected branches.
							{:else if policy.hasRequiredProtectedBranchRules === false}
								None specifically target protected branches.
							{:else}
								Protected-branch scope could not be verified.
							{/if}
							Recreate approval rules on GitHub; imported review history does not enforce them.
						{:else if policy.requiresApprovals === false}
							No required approvals were found in visible project rules.
						{:else}
							Project approval requirements could not be verified. Check GitLab before cutover.
						{/if}
					</p>
				{/if}
				{#if summary.webhookEvents}
					<div class="mt-3 space-y-1 text-[13px] text-[var(--workbench-text-muted)]">
						{#each ["projectWebhooks", "groupWebhooks"] as const as key (key)}
							{#if summary.webhookEvents[key].length > 0}
								<p>{key === "projectWebhooks" ? "Project" : "Group"} hook events observed: {summary.webhookEvents[key].join(", ")}.</p>
							{/if}
						{/each}
						<p>Group hooks count inherited project-hook dependencies, not unique hooks. Ancestors outside the selected namespace are not inspected. Webhooks must be recreated after migration.</p>
					</div>
				{/if}
			</section>
		{/if}

		<section>
			<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300"><Octicon name="database" size={16} />Source storage</h2>
			<div class="grid grid-cols-2 gap-3 {bitbucket ? 'sm:grid-cols-3' : 'lg:grid-cols-5'}">
			{#if bitbucket && summary.projectsCaptured === 0}
					<p class="col-span-full text-sm text-gray-400">No captured repositories to size.</p>
			{:else if bitbucket && unavailableStorageMetrics === storageTiles.length}
					{@const repo = summary.storage.repositorySizeBytes}
					<p class="col-span-full text-sm text-gray-400">{repo.kind === "unavailable" && repo.reason === "forbidden" ? "The Bitbucket connection cannot read repository size details." : "This profile has no Bitbucket size details. Run a new profile to request them."}</p>
			{:else}
				{#each storageTiles as tile (tile.label)}
					<div class="rounded-lg border border-gray-700 bg-gray-900 p-4">
						<div class="text-lg font-semibold text-gray-50">{formatObservation(tile.value, formatBytes)}</div>
						<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400"><Octicon name={tile.icon} size={12} class="text-gray-500" />{tile.label}</div>
						{#if tile.value.kind === "unavailable"}<div class="mt-1 text-xs text-gray-500">{tile.value.reason}</div>{/if}
					</div>
				{/each}
			{/if}
			{#if bitbucket && summary.lfsTracking && summary.projectsCaptured}
				{@const tracking = summary.lfsTracking}
				<div class="col-span-2 rounded-lg border border-gray-700 bg-gray-900 p-4 sm:col-span-1">
					<div class="flex items-center justify-between gap-2">
						<div class="text-lg font-semibold text-gray-50">{tracking.checked ? `${tracking.found} of ${tracking.checked}` : "Not verified"}</div>
						{#if profileId}<a href={`/api/profile/${encodeURIComponent(profileId)}?view=lfs`} download aria-label="Export LFS tracking report (JSON)" title="Export LFS tracking report (JSON)" class="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"><Octicon name="download" size={12} />Export</a>{/if}
					</div>
					<div class="mt-1 flex items-center gap-1.5 text-xs text-gray-400"><Octicon name="file-binary" size={12} class="text-gray-500" />Repos with LFS tracking rules</div>
					{#if tracking.checked && tracking.checked < summary.projectsCaptured}<div class="mt-1 text-xs text-gray-400">{summary.projectsCaptured - tracking.checked} not verified</div>{/if}
				</div>
			{/if}
			</div>
		</section>

		{#if !bitbucket}
			<section>
				<h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-300"><Octicon name="alert" size={16} />Migration risks and coverage</h2>
				<div class="grid gap-px overflow-hidden rounded-lg border border-gray-700 bg-gray-700 {protectionRulesToRecreate ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}">
					<div class="bg-gray-900 p-4"><div class="text-xl font-semibold text-amber-400">{summary.archivedProjects.toLocaleString()}</div><div class="mt-1 text-xs text-gray-400">Archived projects to review</div></div>
					<div class="bg-gray-900 p-4"><div class="text-xl font-semibold text-amber-400">{summary.projectsWithoutDefaultBranch.toLocaleString()}</div><div class="mt-1 text-xs text-gray-400">Without a default branch</div></div>
					<div class="bg-gray-900 p-4"><div class="text-xl font-semibold {unavailableStorageMetrics > 0 ? 'text-amber-400' : 'text-green-400'}">{unavailableStorageMetrics}</div><div class="mt-1 text-xs text-gray-400">Unavailable storage metrics</div></div>
					{#if protectionRulesToRecreate}
						{@const rules = protectionRulesToRecreate}
						<div class="bg-gray-900 p-4"><div class="text-xl font-semibold {rules.kind === 'exact' && rules.value === 0 ? 'text-green-400' : 'text-amber-400'}">{formatObservation(rules)}</div><div class="mt-1 text-xs text-gray-400">Protection rules to recreate</div>{#if rules.kind === "unavailable"}<div class="mt-1 text-xs text-gray-500">{rules.reason}</div>{/if}</div>
					{/if}
				</div>
			</section>
		{/if}
	{:else if !running}
		<p class="flex items-center gap-2 text-sm text-gray-400"><Octicon name="info" size={16} class="shrink-0 text-gray-500" />Inventory summary unavailable for this profile.</p>
	{/if}
</section>