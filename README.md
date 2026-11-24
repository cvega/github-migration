# GitHub Migration Toolkit

Plan and track repository migrations to GitHub Enterprise from a dashboard you host.
Profile a source to find repositories that need attention, choose their destination,
and verify one import before moving the rest.

## Choose your destination

| Destination | Supported sources | Start here |
|---|---|---|
| GitHub Enterprise Cloud (GHEC) | GitHub, GitLab, Bitbucket Server / Data Center | [Configure your source and Cloud target](docs/getting-started.md#configure-providers) |
| GitHub Enterprise Server (GHES) | Bitbucket Server / Data Center | [Deploy the dashboard and run a pilot](docs/bitbucket-datacenter-to-ghes.md) |

## Your first migration

1. **Profile the source.** Pick one repository from the report and review its warnings before planning the import. Profiling does not write to the destination.
2. **Migrate one repository.** Choose the destination organization, confirm the repository name is available, and launch the migration.
3. **Verify the result.** Compare the default branch and its latest commit with the source. Check repository access and the metadata your team relies on before migrating a batch.

## Quick Start

Use the base stack below for a local preview. Before running a migration,
[configure your source and destination](docs/getting-started.md#configure-providers),
including any archive storage or exporter your route requires.

```bash
cp .env.example .env
docker compose up -d --build --wait
```

The template enables unauthenticated access for a trusted local network. Before
exposing the service, configure first-administrator bootstrap credentials. The
dashboard stores Argon2id password hashes and revocable sessions in SQLite.
Open `http://localhost:3000` and choose **Profile**, **New migration**, or
**Mannequins**.

For source development:

```bash
bun install
bun run dev
bun test
bun run verify
```

## Documentation

| Guide | Audience |
|---|---|
| [Getting Started](docs/getting-started.md) | First-time operators and task-oriented paths |
| [Bitbucket Data Center → GHES](docs/bitbucket-datacenter-to-ghes.md) | Deployers setting up the exporter, GHES appliance access, and a one-repository pilot |
| [Configuration](docs/configuration.md) | Deployment owners |
| [Deployment](docs/deployment.md) | Container and proxy operators |
| [Architecture](docs/architecture.md) | Developers and reviewers |
| [API Reference](docs/api.md) | Integrators |
| [Provider Contracts](docs/provider-contracts.md) | Provider maintainers |
| [GitHub Resource Migration Design](docs/github-resource-migration.md) | Migration designers and implementers |
| [Development](docs/development.md) | Contributors |
| [Migration Workbench](docs/design-system/migration-workbench.md) | Designers and frontend contributors |
| [Troubleshooting](docs/troubleshooting.md) | Operators and developers |
| [Contributing](CONTRIBUTING.md) | Contributors |
