#!/bin/sh
# Run with both services stopped. This helper never starts services or removes volumes.
set -eu
umask 077
die() { printf '%s\n' "$*" >&2; exit 1; }
mode=${1:?backup, check-current or restore}
bundle=${2:?snapshot directory}
data=${3:?data directory}
archives=${4:-}
db="$data/gh-migrate.db"

check_db() {
  [ -s "$db" ] || die "No dashboard database in $data"
  checks=$(sqlite3 -readonly "$db" 'PRAGMA integrity_check; PRAGMA foreign_key_check;')
  [ "$checks" = ok ] || die "SQLite integrity or foreign-key check failed"
  active=$(sqlite3 -readonly "$db" "SELECT count(*) FROM migrations WHERE state NOT IN ('succeeded','failed','cancelled')")
  [ "$active" = 0 ] || die "Drain migrations and reconcile Needs review jobs first"
  unfinished=$(sqlite3 -readonly "$db" "SELECT count(*) FROM ghes_import_jobs j JOIN migrations m ON m.id=j.migration_id
    WHERE j.phase NOT IN ('succeeded','failed','cancelled') OR
      (j.phase='succeeded' AND m.state!='succeeded') OR (j.phase IN ('failed','cancelled') AND j.ghes_import_id IS NOT NULL)")
  [ "$unfinished" = 0 ] || die "Reconcile outstanding GHES checkpoints before switching volumes"
}

ledger() {
  sqlite3 -bail -readonly -quote "$db" \
    'SELECT id, source_api_url, source_org, source_repo, target_api_url, target_org, target_repo,
            state, started_at, completed_at, github_migration_id, source_export_id, pipeline_step
       FROM migrations ORDER BY id;
     SELECT migration_id, phase, exporter_job_id, ghes_import_id, updated_at
       FROM ghes_import_jobs ORDER BY migration_id;'
}

checksums() { (cd "$bundle" && sha256sum data.tar archives.tar ledger); }
verify_bundle() {
  [ -s "$bundle/SHA256SUMS" ] || die "Incomplete snapshot"
  actual=$(checksums) || die "Missing snapshot component"
  [ "$actual" = "$(cat "$bundle/SHA256SUMS")" ] || die "Snapshot checksum mismatch"
}
compare_ledger() {
  current=$(mktemp)
  trap 'rm -f "$current"' EXIT
  ledger > "$current"
  cmp -s "$current" "$bundle/ledger" || die "Migration history changed since backup. Keep both datasets; reconcile remote work before switching."
}

case "$mode" in
  backup)
    [ -d "$archives" ] || die "Missing archive volume"
    check_db
    mkdir "$bundle" || die "Use a new snapshot directory"
    ledger > "$bundle/ledger"
    tar -cpf "$bundle/data.tar" -C "$data" .
    tar -cpf "$bundle/archives.tar" -C "$archives" .
    checksums > "$bundle/SHA256SUMS"
    ;;
  check-current)
    check_db
    verify_bundle
    compare_ledger
    ;;
  restore)
    for dest in "$data" "$archives"; do
      [ -d "$dest" ] || die "Restore requires two fresh empty volumes"
      contents=$(ls -A "$dest") || die "Cannot inspect restore destination"
      [ -z "$contents" ] || die "Restore requires two fresh empty volumes"
    done
    data_id=$(stat -Lc '%d:%i' "$data")
    archives_id=$(stat -Lc '%d:%i' "$archives")
    [ "$data_id" != "$archives_id" ] || die "The restore volumes must be distinct"
    verify_bundle
    tar -xpf "$bundle/data.tar" -C "$data"
    tar -xpf "$bundle/archives.tar" -C "$archives"
    check_db
    compare_ledger
    ;;
  *) die "Use backup, check-current or restore" ;;
esac
