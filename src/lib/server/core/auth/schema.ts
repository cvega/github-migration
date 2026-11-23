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
    notes: "Bounded failed attempts keyed by username and client address",
  },
  {
    name: "audit_events",
    purpose: "Authentication and operator action attribution",
    notes: "Stores actors and resources without credentials or session tokens",
  },
  {
    name: "self_service_routes",
    purpose: "One pinned destination per delegated source namespace",
    notes: "Identities include the source provider and instance, not an ephemeral profile run",
  },
  {
    name: "self_service_grants",
    purpose: "Named operator assignments",
    notes: "Grants inventory access with a separate migration permission",
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

  CREATE TABLE IF NOT EXISTS self_service_routes (
    id INTEGER PRIMARY KEY,
    source_provider TEXT NOT NULL CHECK (source_provider IN ('github', 'gitlab', 'bitbucket-server')),
    source_api_url TEXT NOT NULL,
    namespace TEXT NOT NULL COLLATE NOCASE,
    target_profile_id TEXT NOT NULL,
    target_api_url TEXT NOT NULL,
    target_org TEXT NOT NULL,
    UNIQUE (source_provider, source_api_url, namespace)
  );
  CREATE TABLE IF NOT EXISTS self_service_grants (
    id TEXT PRIMARY KEY,
    route_id INTEGER NOT NULL REFERENCES self_service_routes(id),
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    can_migrate INTEGER NOT NULL CHECK (can_migrate IN (0, 1)),
    UNIQUE (user_id, route_id)
  );
`;

export const authStore: DomainStore = {
  applySchema(database: Database): void {
    database.run(AUTH_DDL);
    database
      .prepare(
        `INSERT INTO app_schema_versions (domain, version) VALUES ('auth', 2)
         ON CONFLICT(domain) DO UPDATE SET version = excluded.version`,
      )
      .run();
  },
};
