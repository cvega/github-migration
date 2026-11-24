# GitHub Migration Dashboard

Move repositories to GitHub Enterprise from a dashboard you host. Profile a
source to see which repositories need attention, choose where each one goes,
and follow the import from the queue to the destination repository.

## Choose your destination

For **GitHub Enterprise Server (GHES)**, the dashboard migrates from Bitbucket
Server/Data Center only. [Deploy for GHES and migrate your first repository](docs/bitbucket-datacenter-to-ghes.md).
The walkthrough covers the `bbs-exporter` folder or `.tar.gz` from your
migration team, SSH access to the appliance, and how to verify the import.

For **GitHub Enterprise Cloud (GHEC)**, choose GitHub, GitLab, or Bitbucket
Server/Data Center as the source. [Configure your source and Cloud target](docs/getting-started.md#configure-providers)
or [see a completed Cloud import and its event log](static/imgs/screenshots/migration-detail.png).

## Pilot: Bitbucket to GHES

`PLAT/widgets` → `pilot-imports/widgets`

1. **Profile the source.** In **Profile**, select the `PLAT` project. Check
   that `widgets` appears in the report and review its warnings. Profiling
   reads Bitbucket; it does not start an import.
2. **Confirm the destination.** In **Build migration plan**, select only
   `widgets` and the `pilot-imports` organization. Check that the repository
   name is unused. **Launch batch** writes to GHES, even for a single repository.
3. **Check the imported repository.** Follow the run in **Migrations**. After it
   succeeds, open `pilot-imports/widgets` and compare the default branch,
   a pull request and its author, and repository permissions with the source.
   If the run stops for review, [check the recorded import before retrying](docs/bitbucket-datacenter-to-ghes.md#if-the-pilot-stops).

## Quick start

For a **local preview**, use Docker Engine and Compose v2 from a fresh checkout:

```sh
umask 077
test ! -e .env && cp .env.example .env &&
  docker compose up -d --build --wait
```

Open [localhost:3000](http://localhost:3000) and choose **Setup** to see which
connections are configured. The preview binds to loopback with sign-in **off**
and cannot launch the Bitbucket exporter. Before sharing the dashboard,
[enable sign-in and set its public URL](docs/deployment.md#authentication-and-network).

## Documentation

- **Operate:** [Operator guide](docs/getting-started.md) · [Configuration](docs/configuration.md) · [Deployment and backups](docs/deployment.md) · [Troubleshooting](docs/troubleshooting.md)
- **Integrate:** [API and events](docs/api.md) · [Architecture and supported routes](docs/architecture.md#migration-pipeline) · [Provider contracts](docs/provider-contracts.md)
- **Contribute:** [Development setup](docs/development.md) · [Contributing](CONTRIBUTING.md) · [GitHub resource migration design](docs/github-resource-migration.md) · [Migration workbench](docs/design-system/migration-workbench.md)
