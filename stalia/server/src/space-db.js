/*
 * Where a space keeps its rows: SQLite. The same statements run on Cloudflare D1 and on node:sqlite,
 * through one small interface:
 *   all(sql, params) -> rows     get(sql, params) -> row | null     run(sql, params) -> { changes }
 */

/** The tables. Everything a person typed is in the *_enc columns, encrypted in their browser. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY, name_enc TEXT NOT NULL, created_at INTEGER NOT NULL,
    trial_until INTEGER NOT NULL, paid_until INTEGER NOT NULL DEFAULT 0, licence_id TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, role TEXT NOT NULL, name_enc TEXT NOT NULL, token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS members_space ON members (space_id)`,
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, role TEXT NOT NULL, secret_hash TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, uses_left INTEGER NOT NULL, revoked_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS invites_space ON invites (space_id)`,
  `CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, data_enc TEXT NOT NULL, rev INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS contracts_space ON contracts (space_id)`,
  `CREATE TABLE IF NOT EXISTS calcs (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, contract_id TEXT NOT NULL DEFAULT '', key_wrapped TEXT NOT NULL,
    meta_enc TEXT NOT NULL, meta_head INTEGER NOT NULL, head INTEGER NOT NULL,
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS calcs_space ON calcs (space_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS versions (
    calc_id TEXT NOT NULL, n INTEGER NOT NULL, data_enc TEXT NOT NULL, info_enc TEXT NOT NULL DEFAULT '',
    author_kind TEXT NOT NULL, author_ref TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (calc_id, n))`,
  `CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY, calc_id TEXT NOT NULL, space_id TEXT NOT NULL, role TEXT NOT NULL, label_enc TEXT NOT NULL,
    secret_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS shares_calc ON shares (calc_id)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, calc_id TEXT NOT NULL, body_enc TEXT NOT NULL, author_kind TEXT NOT NULL, author_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS comments_calc ON comments (calc_id, created_at)`,
];

/** One line per statement, as D1 wants them. */
const flat = (sql) => sql.replace(/\s*\n\s*/g, ' ');

export async function ensureSchema(db) {
  for (const sql of SCHEMA) await db.run(flat(sql), []);
}

/**
 * A database file on the server's own disk (or ':memory:').
 * @param {Function} DatabaseSync  the class from node:sqlite, passed in so that the Worker bundle never imports it
 */
export function sqliteDb(DatabaseSync, file) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  const prepared = new Map();
  const prep = (sql) => { let s = prepared.get(sql); if (!s) { s = db.prepare(sql); prepared.set(sql, s); } return s; };
  return {
    async all(sql, params) { return prep(sql).all(...(params || [])); },
    async get(sql, params) { return prep(sql).get(...(params || [])) || null; },
    async run(sql, params) { return { changes: Number(prep(sql).run(...(params || [])).changes) }; },
    close() { db.close(); },
  };
}

/** A Cloudflare D1 database bound to the Worker. */
export function d1Db(d1) {
  return {
    async all(sql, params) { return (await d1.prepare(sql).bind(...(params || [])).all()).results || []; },
    async get(sql, params) { return (await d1.prepare(sql).bind(...(params || [])).first()) || null; },
    async run(sql, params) { const r = await d1.prepare(sql).bind(...(params || [])).run(); return { changes: (r && r.meta && r.meta.changes) || 0 }; },
  };
}
