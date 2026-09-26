import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export const stringify = (data: unknown) =>
  JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export function openStore(
  path = process.env.HS_DATABASE_PATH ??
    fileURLToPath(new URL("../../../var/hyperstrike.sqlite", import.meta.url)),
) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS raw_provider_payloads(hash TEXT PRIMARY KEY,provider_id TEXT NOT NULL,received_at INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS venue_observations(id INTEGER PRIMARY KEY,provider_id TEXT NOT NULL,constituent_id TEXT NOT NULL,source_sequence TEXT,observed_at INTEGER NOT NULL,payload_hash TEXT NOT NULL REFERENCES raw_provider_payloads(hash),data TEXT NOT NULL,UNIQUE(provider_id,constituent_id,source_sequence),UNIQUE(provider_id,constituent_id,payload_hash));
    CREATE TABLE IF NOT EXISTS replay_records(index_id TEXT NOT NULL,observed_at INTEGER NOT NULL,input_hash TEXT NOT NULL,input TEXT NOT NULL,output TEXT NOT NULL,PRIMARY KEY(index_id,observed_at));
    CREATE TABLE IF NOT EXISTS index_observations(index_id TEXT NOT NULL,observed_at INTEGER NOT NULL,sequence INTEGER NOT NULL,data TEXT NOT NULL,provenance TEXT NOT NULL CHECK(provenance IN ('CANONICAL','BACKFILLED')),PRIMARY KEY(index_id,observed_at),UNIQUE(index_id,sequence));
    CREATE TABLE IF NOT EXISTS index_versions(index_id TEXT NOT NULL,version_id TEXT PRIMARY KEY,activates_at INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chain_events(chain_id INTEGER NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(chain_id,tx_hash,log_index));
    CREATE TABLE IF NOT EXISTS markets(market_id TEXT PRIMARY KEY,market_key TEXT UNIQUE NOT NULL,index_id TEXT NOT NULL,data TEXT NOT NULL);
  `);
  for (const table of [
    "raw_provider_payloads",
    "venue_observations",
    "replay_records",
    "index_observations",
    "index_versions",
    "audit_events",
    "chain_events",
    "markets",
  ]) {
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END; CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append-only'); END;`,
    );
  }
  return db;
}
export function commitPayload(
  db: DatabaseSync,
  providerId: string,
  body: string,
  receivedAt: number,
) {
  const hash = `0x${createHash("sha256").update(body).digest("hex")}` as const;
  db.prepare("INSERT OR IGNORE INTO raw_provider_payloads VALUES(?,?,?,?)").run(
    hash,
    providerId,
    receivedAt,
    body,
  );
  return hash;
}
export function audit(db: DatabaseSync, kind: string, data: unknown) {
  db.prepare(
    "INSERT INTO audit_events(kind,created_at,data) VALUES(?,?,?)",
  ).run(kind, Date.now(), stringify(data));
}
