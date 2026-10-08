import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// The database is private to the web service. Both OAuth transactions and
// sessions are encrypted because WAL pages and backups also contain tokens.
export class SqliteConnectedAppBffStore {
  constructor({ filename, encryptionKey, clock = () => Date.now() } = {}) {
    if (typeof filename !== 'string' || !isAbsolute(filename) || resolve(filename) !== filename ||
        filename === ':memory:' || realpathSync(dirname(filename)) !== dirname(filename) ||
        statSync(dirname(filename)).mode & 0o077 ||
        typeof encryptionKey !== 'string' || !/^[a-f0-9]{64}$/i.test(encryptionKey) ||
        typeof clock !== 'function') throw new TypeError('private_bff_store_configuration_required');
    try {
      const info = lstatSync(filename);
      if (!info.isFile() || info.mode & 0o077) throw new TypeError('private_bff_store_configuration_required');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.key = Buffer.from(encryptionKey, 'hex');
    this.clock = clock;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS connected_bff_record (
      kind TEXT NOT NULL CHECK(kind IN ('pending','session')),
      handle_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      sealed TEXT NOT NULL,
      PRIMARY KEY(kind, handle_hash)
    )`);
    this.put = this.db.prepare(`INSERT INTO connected_bff_record(kind,handle_hash,expires_at,sealed)
      VALUES (?,?,?,?) ON CONFLICT(kind,handle_hash) DO UPDATE SET
      expires_at=excluded.expires_at,sealed=excluded.sealed`);
    this.take = this.db.prepare('DELETE FROM connected_bff_record WHERE kind=? AND handle_hash=? RETURNING expires_at,sealed');
    this.get = this.db.prepare('SELECT expires_at,sealed FROM connected_bff_record WHERE kind=? AND handle_hash=?');
    this.delete = this.db.prepare('DELETE FROM connected_bff_record WHERE kind=? AND handle_hash=?');
    this.pruneStatement = this.db.prepare('DELETE FROM connected_bff_record WHERE expires_at <= ?');
  }

  close() { this.db.close(); this.key.fill(0); }
  prune() { return this.pruneStatement.run(this.clock()).changes; }

  seal(kind, handleHash, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${kind}:${handleHash}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  open(kind, handleHash, sealed) {
    const bytes = Buffer.from(sealed, 'base64');
    if (bytes.length < 29) throw new Error('bff_record_invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${kind}:${handleHash}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }

  async putPending(handleHash, value) {
    if (!digest(handleHash) || !Number.isSafeInteger(value?.createdAt)) throw new TypeError('invalid_bff_pending');
    this.prune();
    this.put.run('pending', handleHash, value.createdAt + 300_000, this.seal('pending', handleHash, value));
  }

  async takePending(handleHash) {
    if (!digest(handleHash)) return null;
    // DELETE RETURNING is one SQLite write transaction: a second process
    // cannot consume this transaction, including after restart.
    const row = this.take.get('pending', handleHash);
    return row && row.expires_at > this.clock() ? this.open('pending', handleHash, row.sealed) : null;
  }

  async putSession(handleHash, value) {
    if (!digest(handleHash) || !Number.isSafeInteger(value?.expiresAt) || value.expiresAt <= this.clock())
      throw new TypeError('invalid_bff_session');
    this.prune();
    this.put.run('session', handleHash, value.expiresAt, this.seal('session', handleHash, value));
  }

  async getSession(handleHash) {
    if (!digest(handleHash)) return null;
    const row = this.get.get('session', handleHash);
    if (!row) return null;
    if (row.expires_at <= this.clock()) { this.delete.run('session', handleHash); return null; }
    return this.open('session', handleHash, row.sealed);
  }

  async deleteSession(handleHash) {
    if (digest(handleHash)) this.delete.run('session', handleHash);
  }
}
