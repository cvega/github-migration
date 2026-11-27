import type { Migration } from "$lib/migrate/types";
import { recordAuditEvent } from "$lib/server/core/auth/audit";

export function auditSourceTlsOverride(
  migration: Pick<Migration, "id" | "sourceApiUrl">,
  operation: "start" | "restart" | "dispatch" | "recovery",
  outcome: "admitted" | "allowed" | "denied",
  actorUserId: string | null | undefined,
) {
  const source = URL.parse(migration.sourceApiUrl);
  recordAuditEvent({
    actorUserId,
    action: "migration.source_tls_override",
    resourceType: "migration",
    resourceId: migration.id,
    metadata: {
      operation,
      outcome,
      noSslVerify: true,
      actor: actorUserId === undefined ? "system" : actorUserId ? "user" : "unauthenticated",
      sourceOrigin: source?.protocol === "https:" ? source.origin : null,
    },
  });
}
