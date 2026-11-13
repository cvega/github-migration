<p align="center">
	<img src="static/imgs/github-logo.png" width="80" height="80" alt="GitHub" />
</p>
<h1 align="center">GitHub Migration Dashboard</h1>

<p align="center">
	<strong>Profile, plan, and migrate repositories from GitHub, GitLab, or Bitbucket Server to GitHub targets.</strong>
</p>

The dashboard combines provider-aware source profiling, guided single and
batch setup, durable migration execution, live SSE progress, cancellation,
restart, reconciliation, crash recovery, and operational statistics.

## Capabilities

- Profile GitHub organizations, GitLab namespaces, and Bitbucket projects.
- Analyze GitHub repository history and LFS evidence in a separate worker.
- Build migration plans from readiness findings and repository mappings.
- Migrate to GHEC or a configured GHES target where the provider path supports it.
- Map GHEC mannequins to target organization members and send attribution invitations.
- Queue up to 500 batch members under an app-wide concurrency limit of ten.
- Resume work from durable provider, GitHub, and GHES import checkpoints.
- Authenticate GitHub with PATs or Apps while keeping provider and GHES secrets server-only.
- Run as one non-root container with SQLite WAL persistence and readiness probes.

## Quick Start

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

## Screenshots

| Sign in | Workspace |
|---|---|
| ![Sign in](static/imgs/screenshots/login.png) | ![Workspace](static/imgs/screenshots/home.png) |
| Profiles | Profile readiness |
| ![Profile runs](static/imgs/screenshots/profile.png) | ![Profile readiness](static/imgs/screenshots/profile-detail.png) |
| Migration dashboard | Migration search |
| ![Migration dashboard](static/imgs/screenshots/dashboard.png) | ![Migration search results](static/imgs/screenshots/search.png) |
| New migration | Active batch |
| ![New migration](static/imgs/screenshots/new-migration.png) | ![Active batch](static/imgs/screenshots/batch.png) |
| Migration detail | Statistics |
| ![Migration detail](static/imgs/screenshots/migration-detail.png) | ![Migration statistics](static/imgs/screenshots/stats.png) |
| Mannequins | Setup |
| ![Mannequin user map](static/imgs/screenshots/mannequins.png) | ![Provider setup](static/imgs/screenshots/setup.png) |

## Documentation

| Guide | Audience |
|---|---|
| [Getting Started](docs/getting-started.md) | First-time operators and task-oriented paths |
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
