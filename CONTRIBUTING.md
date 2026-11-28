# Contributing

## Development Setup

Install Bun 1.4.4, then run:

```bash
bun install --frozen-lockfile
bun run dev
```

Use Bun for package management, scripts, and tests. Keep changes focused on one
behavior or ownership boundary and preserve public payloads and durable schema
unless the change explicitly includes a migration or API cutover.

## Before Submitting

Run the narrowest relevant tests while developing, then follow the
[verification rules](AGENTS.md#verification-and-generated-files).

For UI changes, also run the affected Playwright workflow at desktop and mobile
widths. For documentation contract changes, run `bun run docs:sync` followed by
`bun run docs:check`.

## Code Conventions

- Follow existing TypeScript, Svelte 5, and Biome formatting.
- Follow the [Migration Workbench](docs/design-system/migration-workbench.md) design system for visual and interaction work.
- Keep server domains isolated; compose cross-domain policy and adapters in
	`application`, and keep routes focused on HTTP transport.
- Keep browser DTOs in client-safe domain modules.
- Use real structured parsers for provider and persisted data.
- Add comments only when the reason is not apparent from the code.
- Do not add compatibility routes, duplicate stores, or speculative schedule behavior.
- Never place credentials in fixtures, events, logs, screenshots, or page data.
- Use `Bun.password` with the shared Argon2id policy for dashboard passwords.
- Store only session-token digests and use request locals as the downstream identity source.
- Enforce user-role and final-administrator invariants in server services, not UI controls.
- Audit successful operator mutations without recording credentials or tokens.

## Tests

Behavior tests should assert stable contracts rather than incidental prose.
Persistence tests use in-memory SQLite. From 1.0 on; before 1.0 see
[Pre-1.0 policy](AGENTS.md#pre-10-policy). Use a file when testing durable
upgrade behavior. External provider tests must remain deterministic and
offline. Live tests are opt-in and use disposable data.

See [Development](docs/development.md) for the gate suite and
[Architecture](docs/architecture.md) for ownership rules.
