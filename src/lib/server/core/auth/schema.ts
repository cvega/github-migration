import type { Database } from "bun:sqlite";
import type { DomainStore, DurableTableContract } from "$lib/server/core/db";

export const AUTH_DURABLE_TABLES = [
  {
    name: "app_users",
    purpose: "Dashboard user identities and credentials",
    notes: "Usernames are unique case-insensitively; passwords are stored as Argon2id hashes",
  },
  {
    name: "app_sessions",
    purpose: "Revocable dashboard sessions",
    notes: "Stores SHA-256 token digests, never raw cookie values",
  },
  {
    name: "auth_login_attempts",
    purpose: "Persistent sign-in throttling",
    notes: "Counts pending and failed sign-in attempts by username and client address",
  },
  {
    name: "audit_events",
    purpose: "Authentication and operator action attribution",
    notes: "Stores actors and resources without credentials or session tokens",
  },
  {
    name: "self_service_routes",
    purpose: "Exact source-to-destination routes available for delegation",
    notes: "Identities include the source provider and instance, not an ephemeral profile run",
  },
  {
    name: "self_service_grants",
    purpose: "Named operator assignments",
    notes: "Grants inventory access with a separate migration permission",
  },
  {
    name: "target_organizations",
    purpose: "Administrator-listed migration destinations",
    notes:
      "Organization logins belong to one target connection and API instance; listing grants no access",
  },
] as const satisfies readonly DurableTableContract[];

const AUTH_DDL = `
  CREATE TABLE IF NOT EXISTS app_schema_versions (
    domain TEXT PRIMARY KEY,
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id, revoked_at);
  CREATE INDEX IF NOT EXISTS idx_app_sessions_expiry ON app_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS auth_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE,
    ip_address TEXT NOT NULL,
    attempted_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_auth_attempts_user_ip
    ON auth_login_attempts(username, ip_address, attempted_at);
  CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip
    ON auth_login_attempts(ip_address, attempted_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    target_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
    ip_address TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_resource
    ON audit_events(resource_type, resource_id, created_at DESC);
`;

const ROUTES_DDL = `
  CREATE TABLE IF NOT EXISTS target_organizations (
    target_profile_id TEXT NOT NULL,
    target_api_url TEXT NOT NULL,
    organization TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (target_profile_id, target_api_url, organization)
  );
  CREATE TABLE IF NOT EXISTS self_service_routes (
    id INTEGER PRIMARY KEY,
    source_provider TEXT NOT NULL CHECK (source_provider IN ('github', 'gitlab', 'bitbucket-server')),
    source_api_url TEXT NOT NULL,
    namespace TEXT NOT NULL,
    target_profile_id TEXT NOT NULL,
    target_api_url TEXT NOT NULL,
    target_org TEXT NOT NULL,
    UNIQUE (source_provider, source_api_url, namespace, target_profile_id, target_api_url, target_org)
  );
  CREATE TABLE IF NOT EXISTS self_service_grants (
    id TEXT PRIMARY KEY,
    route_id INTEGER NOT NULL REFERENCES self_service_routes(id),
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    can_migrate INTEGER NOT NULL CHECK (can_migrate IN (0, 1)),
    UNIQUE (user_id, route_id)
  );
  CREATE INDEX IF NOT EXISTS idx_self_service_grants_route ON self_service_grants(route_id);
`;

export const authStore: DomainStore = {
  applySchema(database: Database): void {
    database
      .transaction(() => {
        database.run(AUTH_DDL);
        const version = database
          .query<{ version: number }, []>(
            "SELECT version FROM app_schema_versions WHERE domain='auth'",
          )
          .get()?.version;
        if (version !== undefined && version > 4)
          throw new Error("Unsupported dashboard auth schema");
        if (version === 2) {
          // Rebuild both sides of the foreign key with enforcement still enabled.
          database.run(`ALTER TABLE self_service_routes RENAME TO self_service_routes_v2;
          ALTER TABLE self_service_grants RENAME TO self_service_grants_v2;`);
        }
        database.run(ROUTES_DDL);
        if (version === 2) {
          database.run(`INSERT INTO self_service_routes
            SELECT id,source_provider,source_api_url,namespace,target_profile_id,target_api_url,target_org FROM self_service_routes_v2;
          INSERT INTO self_service_grants SELECT id,route_id,user_id,can_migrate FROM self_service_grants_v2;
          DROP TABLE self_service_grants_v2;
          DROP TABLE self_service_routes_v2;`);
        }
        if (version !== 4)
          database.run(`INSERT INTO app_schema_versions (domain,version) VALUES ('auth',4)
          ON CONFLICT(domain) DO UPDATE SET version=excluded.version`);
      })
      .immediate();
  },
};
