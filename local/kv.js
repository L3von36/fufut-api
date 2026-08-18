/**
 * KV namespaces backed by a table in the same SQLite file.
 *
 * The six namespaces hold website content, the published menu cache and a few
 * order/reservation mirrors. Keeping them in the local database rather than in
 * loose files means one file to back up and one thing to copy off the box each
 * night — the restore story stays simple, which is the part that matters when
 * somebody is doing it under pressure.
 *
 * Only get/put/delete are used by the handlers today; list is here because it
 * is part of the KV contract and a future handler reaching for it should not
 * discover the local box is the one place it does not exist.
 */

const TABLE = `CREATE TABLE IF NOT EXISTS _local_kv (
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT,
  metadata  TEXT,
  expires   INTEGER,
  PRIMARY KEY (namespace, key)
)`;

class LocalKV {
  constructor(db, namespace) {
    this.db = db;
    this.namespace = namespace;
  }

  async get(key, options) {
    const type = typeof options === 'string' ? options : options?.type || 'text';
    const row = this.db
      .prepare('SELECT value, expires FROM _local_kv WHERE namespace = ? AND key = ?')
      .get(this.namespace, key);
    if (!row) return null;
    // KV drops expired keys rather than returning them; so do we, lazily.
    if (row.expires && row.expires <= Date.now()) {
      await this.delete(key);
      return null;
    }
    if (type === 'json') {
      try { return JSON.parse(row.value); } catch { return null; }
    }
    if (type === 'arrayBuffer') return new TextEncoder().encode(row.value).buffer;
    return row.value;
  }

  async getWithMetadata(key, options) {
    const value = await this.get(key, options);
    const row = this.db
      .prepare('SELECT metadata FROM _local_kv WHERE namespace = ? AND key = ?')
      .get(this.namespace, key);
    let metadata = null;
    try { metadata = row?.metadata ? JSON.parse(row.metadata) : null; } catch { /* keep null */ }
    return { value, metadata };
  }

  async put(key, value, options = {}) {
    const expires = options.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options.expiration
        ? options.expiration * 1000
        : null;
    const body = typeof value === 'string' ? value : new TextDecoder().decode(value);
    this.db
      .prepare(
        `INSERT INTO _local_kv (namespace, key, value, metadata, expires) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value,
           metadata = excluded.metadata, expires = excluded.expires`
      )
      .run(this.namespace, key, body, options.metadata ? JSON.stringify(options.metadata) : null, expires);
  }

  async delete(key) {
    this.db.prepare('DELETE FROM _local_kv WHERE namespace = ? AND key = ?').run(this.namespace, key);
  }

  async list({ prefix = '', limit = 1000 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT key, expires FROM _local_kv
         WHERE namespace = ? AND key LIKE ? AND (expires IS NULL OR expires > ?)
         ORDER BY key LIMIT ?`
      )
      .all(this.namespace, prefix + '%', Date.now(), limit);
    return { keys: rows.map((r) => ({ name: r.key, expiration: r.expires ? r.expires / 1000 : undefined })), list_complete: true, cursor: undefined };
  }
}

export function createKVNamespaces(db, names) {
  db.exec(TABLE);
  const out = {};
  for (const name of names) out[name] = new LocalKV(db, name);
  return out;
}
