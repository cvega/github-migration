# Getting started: Bitbucket Data Center to GitHub Enterprise Server

Use this guide to deploy the dashboard and migrate **one repository** before
starting a batch. The example moves `PLAT/widgets` from Bitbucket Data Center to
`pilot-imports/widgets` on your GHES appliance. The dashboard calls the source
**Bitbucket Server**. This is not the Bitbucket Cloud or GitHub Enterprise Cloud route.

The dashboard profiles Bitbucket over its REST API. For a migration, a one-shot
`bbs-exporter` container reads the repository and writes an archive; the dashboard
copies it to GHES over SSH and runs `ghe-migrator` there. **Launching the pilot
writes to GHES.** The exporter does not lock Bitbucket. For a final cutover,
arrange a source write freeze rather than expecting later changes to be copied.

## 1. Prepare the source, destination, and deployment host

| Where | What you need before starting |
|---|---|
| Bitbucket Data Center | A project **key** (`PLAT`), repository slug (`widgets`), and service account that can read the project, clone the repository over HTTPS, and read its PR and permission metadata. Use its username and a password or user token accepted for Basic authentication. The dashboard's inventory check requires Bitbucket 5.14 or later; confirm exporter compatibility with your version separately. |
| GHES web/API | Create or select the **organization**, not the repository. Use a test organization and verify that the target repository name is unused. Obtain a **GHES site administrator's** username and PAT issued on **that appliance**. `ghe-migrator` uses the PAT to authenticate the site admin; the dashboard also needs API access to the target org, users, and migrated repository. |
| GHES management SSH | Have the appliance administrator add the deployment **public** key in **Management Console → SSH access**. Obtain the SSH host key's OpenSSH `SHA256:` fingerprint through a trusted, independent channel. This is the **server's** fingerprint, not the deployment key's. The remote staging directory must exist, be writable by the SSH account, and have room for the archive. |
| Deployment host | Use a trusted Linux host with Docker Engine, Compose v2, and persistent storage. Both the dashboard and the exporter need DNS, trusted TLS, and HTTPS access to Bitbucket. The dashboard also needs GHES HTTPS and administrative SSH (normally TCP 122; the management and web hostnames may differ). Reserve space for the archive on the Docker host and for staging and import on GHES. |

**Get the exporter before going further.** It is not included in this checkout
or in the dashboard image. GitHub lists `bbs-exporter` as an
[expert-led migration tool](https://docs.github.com/en/migrations/overview/migration-paths-to-github#bitbucket-server-or-bitbucket-data-center-to-github-enterprise-server).
Obtain an approved image digest or an authorized build context from your migration
team or [GitHub Expert Services](https://github.com/services/). A clean deployment
cannot use the local validation tag unless you build it.

No GitHub.com PAT, GitHub App, Bitbucket administrative SSH key, or Bitbucket
shared-home mount is needed. Source-side SFTP is for **Bitbucket → GHEC**.
For the two web credentials, see [Bitbucket user HTTP access tokens](https://confluence.atlassian.com/bitbucketserver/http-access-tokens-939515499.html)
and [creating a PAT on GHES](https://docs.github.com/en/enterprise-server@latest/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
See GitHub's [GHES shell setup](https://docs.github.com/en/enterprise-server@latest/admin/administering-your-instance/administering-your-instance-from-the-command-line/accessing-the-administrative-shell-ssh)
and [GHES import guide](https://docs.github.com/en/enterprise-server@latest/migrations/using-ghe-migrator/migrating-data-to-github-enterprise-server)
for appliance-side requirements; select your GHES version.

## 2. Configure a fresh checkout

From the root of a clean checkout of the dashboard release you intend to deploy:

```sh
umask 077
test ! -e .env && cp .env.example .env
```

Edit `.env` privately. **Replace** the template's `GH_MIGRATE_ALLOW_UNAUTHENTICATED=true`
line; do not leave unauthenticated mode enabled. Substitute your own endpoints and
secret values for the examples below. Do not commit the file, source it as a shell
script, or share expanded Compose output.

```dotenv
COMPOSE_FILE=docker-compose.yml:compose.exporter.yml
GH_MIGRATE_ALLOW_UNAUTHENTICATED=false
GH_MIGRATE_USER=migration-admin
GH_MIGRATE_PASS='<unique 12-128 character dashboard password>'
ORIGIN=http://localhost:3000

BITBUCKET_SERVER_URL=https://bitbucket.example.com
BITBUCKET_SERVER_USERNAME=bb-migration
BITBUCKET_SERVER_PASSWORD='<Bitbucket service-account credential>'
BITBUCKET_SERVER_PROJECT_KEYS=PLAT

GHES_TARGET_ID=ghes
GHES_TARGET_NAME='GHES pilot'
GHES_TARGET_API_URL=https://github.example.com/api/v3
GHES_TARGET_ORG=pilot-imports
GHES_TARGET_ADMIN_USERNAME=ghes-migration-admin
GHES_TARGET_ADMIN_PAT='<PAT for this GHES site administrator>'
GHES_TARGET_SSH_HOST=ghes-admin.example.com
GHES_TARGET_SSH_PORT=122
GHES_TARGET_SSH_USERNAME=admin
GHES_TARGET_SSH_PRIVATE_KEY='<one-line base64 of the deployment private key>'
GHES_TARGET_SSH_HOST_KEY_SHA256='SHA256:<verified appliance host fingerprint>'
GHES_TARGET_REMOTE_DIR=/home/admin

BBS_EXPORTER_IMAGE=registry.example.com/migrations/bbs-exporter@sha256:<approved-digest>
EXPORTER_ARCHIVE_VOLUME=pilot-migration-archives
EXPORTER_NETWORK=bridge
```

- The dashboard login, GHES site-admin login, and GHES shell account are separate.
  The SSH client accepts PEM or base64-encoded PEM and must be able to load the key
  noninteractively. Base64 is not encryption; protect it as a private key.
- Leave port 3000 bound to loopback for initial setup. For a reverse proxy, set
  `ORIGIN` to the exact browser-visible HTTPS origin **before** startup. Even
  `localhost` and `127.0.0.1` are different browser origins.
- Keep the project and organization lists explicit; use commas for multiple entries.
  `PROFILE_CONNECTION_SCOPE=bitbucket-server` optionally broadens **profiling only**.
  It does not allow operators to migrate additional projects.
- Compose mounts the same named volume at `/archives` in the dashboard and
  `/workspace` in each exporter. Keep the volume name stable and dedicated to this
  deployment. The exporter override mounts the Docker socket **in the dashboard**;
  treat access to that service as privileged access to its Docker host.
- **Only for the local Bitbucket Compose stack:** start that stack first. Set
  `COMPOSE_FILE=docker-compose.yml:compose.exporter.yml:compose.bitbucket-local.yml`
  and `EXPORTER_NETWORK=bitbucket-local_default`. Use the Bitbucket service's
  reachable URL, not `localhost`; `BITBUCKET_SERVER_ALLOW_INSECURE_HTTP=true`
  is for an explicitly trusted HTTP test source only. An external Bitbucket does
  not need this override.

## 3. Make the exporter available and start the dashboard

Run these in the same checkout, against the Docker daemon used by the dashboard.
Choose **one** exporter path:

- **Approved registry image:** keep the digest reference in `.env`. Authenticate
  to your registry through its normal credential helper, then pull that exact image:

  ```sh
  image=$(docker compose --profile tools config --images bbs-exporter-image)
  docker pull "$image"
  docker image inspect --format '{{json .RepoDigests}}' "$image"
  ```

  Check that the result contains your approved digest.
- **Authorized source build for a pilot:** set `BBS_EXPORTER_IMAGE=gh-migrate/bbs-exporter:1.13.0-validation`
  **instead of** the digest reference. Put the approved exporter build context
  (including its Dockerfile) at `../bbs-exporter-1.13.0`, or set
  `BBS_EXPORTER_BUILD_CONTEXT` to its path. Run
  `docker compose --profile tools build bbs-exporter-image`. The tools profile
  builds an image, not a long-running service. For production, publish an
  approved build and use its digest.

```sh
docker compose config --quiet
docker compose up -d --build --wait gh-migrate profile-analyzer
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/ready
docker compose exec -T --user app gh-migrate docker version --format '{{.Server.Version}}'
docker compose exec -T --user app gh-migrate test -w /archives
```

Expect a `ready` response, a Docker server version, and a successful archive
permission check. From a trusted admin terminal on the deployment network, you
can also check the two HTTPS reads below. Replace the examples first; enter the
respective password/token at curl's prompt, not in the command line. Both should
return `200`. Use the same accounts configured for the dashboard.

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --user bb-migration https://bitbucket.example.com/rest/api/1.0/projects/PLAT/repos/widgets
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  --user ghes-migration-admin https://github.example.com/api/v3/orgs/pilot-imports
```

For SSH, use the deployment key and a `known_hosts` entry verified against the
appliance fingerprint. This checks the management endpoint without preparing or
importing anything:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes \
  -i /secure/ghes-deployment-key -p 122 admin@ghes-admin.example.com \
  'command -v ghe-migrator && test -w /home/admin'
```

Sign in at the configured `ORIGIN`. In **Setup → Targets**,
look for **Ready** on the **Bitbucket Server** row of the **GHES** target, not
Cloud. These are process and configuration checks; none tests a real import.
Once sign-in works, remove both bootstrap login values from the deployment
environment and recreate the services while idle. Keep the same Compose files
and volumes; `docker compose restart` alone does not reload environment changes.

## 4. Profile a project and run one repository

1. As a dashboard admin, open **Profile → New profile**, choose **Bitbucket
   Server**, select the single-namespace scope, and use **Discover namespaces**
   to pick `PLAT`. Click **Start profile**. Wait for the report to complete and
   check that it lists `PLAT/widgets`. This reads the source; it does not write
   to GHES.
2. In **Manage targets**, verify `pilot-imports` belongs to the **Server**
   connection. An org in `GHES_TARGET_ORG` is listed automatically; listing it
   neither creates the org on GHES nor grants anyone access. If someone else will
   run the pilot, use **Manage users → user → Migration access** to assign
   `PLAT` to that Server destination with **View and migrate**.
3. If identities need translating, use **Mappings** as an admin: map a Bitbucket
   username to its existing GHES login, or a Bitbucket project key and group name
   to an existing team slug in the target org. These decisions apply to imports;
   they are not dashboard access grants. A suggested team merge is not an approval.
4. In the profile's **Build migration plan**, select **only** `PLAT/widgets`.
   Verify the GHES host, `pilot-imports` organization, and unused target name.
   Choose **Launch batch**. One selected repository is a one-repository batch;
   there is no dry run for this import.
5. Open the migration in **Migrations**. Expect export, archive transfer,
   preparation, mapping, import, audit, and unlock. After **Succeeded**, open
   `pilot-imports/widgets` on GHES. Compare the default branch and commit,
   branches, tags, a representative PR and its attribution, and intended access.
   If the source uses LFS, fetch a representative object; a pointer alone is not
   proof the payload arrived. Git tags are preserved, but the exporter excludes
   release metadata. Approve a larger batch only after the pilot checks pass.

## If the pilot stops

| Symptom | Next check |
|---|---|
| Source profiles, but the exporter cannot start or reach Bitbucket | Check the image on the **same daemon**, the exporter override and socket, archive volume, and exporter network/DNS. A working dashboard API connection does not prove exporter connectivity. |
| Missing destination or **View only** | Check the GHES instance, project and org allowlists, and the user's exact source–destination grant. Do not broaden credential scope to work around a missing grant. |
| SSH authentication or host verification fails | Confirm management hostname, port, authorized public key, and the appliance's trusted fingerprint. Never disable verification. |
| Name or identity conflict | Choose an unused destination for a new pilot rather than deleting a repository. For an identity conflict, have an admin review the detailed event and approve the exact mapping before retrying. |
| **Review required** | Stop. Record the migration ID and saved GHES GUID. Have the appliance admin inspect that GUID, for example with read-only `ghe-migrator audit -g <GUID>`. Do not infer that an import is inactive from an absent repo, clear its checkpoint, or submit another import. Audit/unlock recovery uses the same GUID. |

GHES imports run one at a time; a failed or held Bitbucket job keeps the rest of
its batch queued. Keep `/data` and `/archives` for recovery. Before a production
cutover, follow [Deployment: promotion and rollback](deployment.md#promotion-and-rollback)
for quiescing, paired backups, and restore. Restoring the dashboard does not
undo an import on GHES.
