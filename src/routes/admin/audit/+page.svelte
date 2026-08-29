<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";

	let { data } = $props();

	const actionLabels: Record<string, string> = {
		"auth.login.succeeded": "Signed in",
		"auth.login.failed": "Sign-in failed",
		"auth.logout": "Signed out",
		"auth.password.changed": "Changed password",
		"auth.password.reset": "Reset password",
		"auth.sessions.revoked": "Revoked sessions",
		"auth.user.bootstrapped": "Created first administrator",
		"auth.user.created": "Added user",
		"auth.user.disabled": "Disabled user",
		"auth.user.enabled": "Enabled user",
		"auth.user.role_changed": "Changed user role",
		"migration.started": "Started migration",
		"migration.cancelled": "Cancelled migration",
		"migration.restarted": "Restarted migration",
		"migration.restart_confirmed": "Confirmed migration restart",
		"batch.started": "Started migration batch",
		"batch.cancelled": "Cancelled migration batch",
		"batch.restarted": "Restarted migration batch",
		"profile.started": "Started profile",
	};

	const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "medium",
	}).format(new Date(value));
</script>

<svelte:head><title>Audit log - GitHub Migration Toolkit</title></svelte:head>

<div class="space-y-6">
	<header>
		<div class="mb-2 flex items-center gap-2 text-sm font-medium text-green-400"><Octicon name="shield" size={16} />Administration</div>
		<h1 class="text-2xl font-semibold text-gray-50">Audit log</h1>
		<p class="mt-2 text-sm text-gray-400">The 200 most recent authentication and operator actions.</p>
	</header>

	<section aria-label="Audit events" class="overflow-hidden rounded-md border border-gray-700 bg-gray-900">
		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead class="bg-gray-800/50 text-xs text-gray-500"><tr><th class="px-4 py-2 font-medium">Time</th><th class="px-4 py-2 font-medium">User</th><th class="px-4 py-2 font-medium">Action</th><th class="px-4 py-2 font-medium">Target</th></tr></thead>
				<tbody class="divide-y divide-gray-800">
					{#each data.events as event (event.id)}
						<tr><td class="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{formatDate(event.createdAt)}</td><td class="px-4 py-3 text-gray-300">{event.actorUsername ?? (event.action === "auth.user.bootstrapped" ? "System" : event.action === "auth.login.failed" ? "Unknown user" : "Unauthenticated operator")}</td><td class="px-4 py-3 text-gray-200">{actionLabels[event.action] ?? event.action}</td><td class="px-4 py-3 text-gray-400">{event.targetUsername ?? event.resourceId ?? "-"}</td></tr>
					{:else}
						<tr><td colspan="4" class="px-4 py-10 text-center text-gray-500">No audit events recorded.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</div>