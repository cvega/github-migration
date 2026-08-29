<script lang="ts">
	import { enhance } from "$app/forms";
	import Octicon from "$lib/components/Octicon.svelte";

	let { data, form } = $props();
	let submitting = $state(false);
</script>

<svelte:head><title>{data.user.username} - Users - GitHub Migration Toolkit</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<header>
		<a href="/admin/users" class="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200"><Octicon name="chevron-left" size={16} />Users</a>
		<h1 class="mt-3 text-2xl font-semibold text-gray-50">{data.user.displayName ?? data.user.username}</h1>
		{#if data.user.displayName}<p class="mt-1 text-sm text-gray-500">{data.user.username}</p>{/if}
	</header>

	{#if form?.error}<p role="alert" class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{form.error}</p>{/if}
	{#if form?.success}<p role="status" class="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">{form.success}</p>{/if}
	{#if form?.temporaryPassword}<div class="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-200"><p>Share this temporary password securely. It will not be shown again.</p><code class="mt-3 block overflow-x-auto rounded-md bg-gray-950 px-3 py-2 text-gray-50">{form.temporaryPassword}</code></div>{/if}

	<div class="divide-y divide-gray-700 rounded-md border border-gray-700 bg-gray-900">
		<section class="flex flex-wrap items-center justify-between gap-4 p-5">
			<div><h2 class="text-sm font-semibold text-gray-200">Role</h2><p class="mt-1 text-xs text-gray-500">Administrators can manage users and all migration operations.</p></div>
			<form method="POST" action="?/role" use:enhance><select name="role" aria-label="Role" disabled={data.currentUser.id === data.user.id} class="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50"><option value="operator" selected={data.user.role === "operator"}>Operator</option><option value="admin" selected={data.user.role === "admin"}>Administrator</option></select><button type="submit" class="ml-2 rounded-md border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800">Save</button></form>
		</section>
		<section class="flex flex-wrap items-center justify-between gap-4 p-5">
			<div><h2 class="text-sm font-semibold text-gray-200">Access</h2><p class="mt-1 text-xs text-gray-500">Disabled users are signed out and cannot sign in.</p></div>
			<form method="POST" action="?/status" use:enhance onsubmit={(event) => { if (data.user.isActive && !confirm(`Disable ${data.user.username}? They will be signed out and cannot sign in.`)) event.preventDefault(); }}><input type="hidden" name="isActive" value={data.user.isActive ? "false" : "true"} /><button type="submit" disabled={data.currentUser.id === data.user.id} class="rounded-md border px-3 py-2 text-sm {data.user.isActive ? 'border-red-500/40 text-red-300 hover:bg-red-500/10' : 'border-green-500/40 text-green-300 hover:bg-green-500/10'} disabled:opacity-40">{data.user.isActive ? "Disable user" : "Enable user"}</button></form>
		</section>
		<section class="flex flex-wrap items-center justify-between gap-4 p-5">
			<div><h2 class="text-sm font-semibold text-gray-200">Password</h2><p class="mt-1 text-xs text-gray-500">Generate a temporary password and require a change at next sign-in.</p></div>
			<form method="POST" action="?/reset" use:enhance={() => { submitting = true; return async ({ update }) => { submitting = false; await update(); }; }} onsubmit={(event) => { if (!confirm(`Reset the password for ${data.user.username}? They will be signed out.`)) event.preventDefault(); }}><button type="submit" disabled={submitting || data.currentUser.id === data.user.id} class="inline-flex items-center gap-2 rounded-md border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50"><Octicon name="key" size={16} />Reset password</button></form>
		</section>
		<section class="flex flex-wrap items-center justify-between gap-4 p-5">
			<div><h2 class="text-sm font-semibold text-gray-200">Sessions</h2><p class="mt-1 text-xs text-gray-500">Sign this user out on every device.</p></div>
			<form method="POST" action="?/revoke" use:enhance onsubmit={(event) => { if (!confirm(`Revoke every session for ${data.user.username}?`)) event.preventDefault(); }}><button type="submit" disabled={data.currentUser.id === data.user.id} class="inline-flex items-center gap-2 rounded-md border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50"><Octicon name="sign-out" size={16} />Revoke sessions</button></form>
		</section>
	</div>
</div>