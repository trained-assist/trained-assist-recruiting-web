import { chmodSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Private operational audit only: never stores message text or attachment URLs.
export class SqliteResponseConversationAudit {
  constructor({ filename, clock = () => new Date() } = {}) {
    if (typeof filename !== 'string' || !isAbsolute(filename) || resolve(filename) !== filename ||
        realpathSync(dirname(filename)) !== dirname(filename) || (statSync(dirname(filename)).mode & 0o077) !== 0 ||
        typeof clock !== 'function') throw new TypeError('private_conversation_audit_configuration_required');
    try {
      const info = lstatSync(filename);
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new TypeError('private_conversation_audit_configuration_required');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.db = new Database(filename, { timeout: 5000 });
    this.clock = clock;
    chmodSync(filename, 0o600);
    // This table shares the host's private DB with other repositories. Preserve
    // its existing journal mode so opening this handle cannot disrupt readers.
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS response_conversation_access (
      attempt_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      vacancy_id TEXT NOT NULL,
      negotiation_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('started','completed','failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.insert = this.db.prepare(`INSERT INTO response_conversation_access
      (attempt_id,profile_id,vacancy_id,negotiation_id,chat_id,outcome,created_at,updated_at)
      VALUES (@attemptId,@profileId,@vacancyId,@negotiationId,@chatId,'started',@now,@now)`);
    this.finishUpdate = this.db.prepare(`UPDATE response_conversation_access SET outcome=@outcome,updated_at=@now
      WHERE attempt_id=@attemptId AND outcome='started'`);
    this.getOne = this.db.prepare('SELECT * FROM response_conversation_access WHERE attempt_id=?');
  }

  close() { this.db.close(); }

  async start({ attemptId, profileId, vacancyId, negotiationId, chatId }) {
    if (![attemptId, profileId, vacancyId, negotiationId, chatId].every(safeId))
      throw new TypeError('invalid_conversation_audit_event');
    const now = this.clock().toISOString();
    this.insert.run({ attemptId, profileId, vacancyId, negotiationId, chatId, now });
  }

  async finish({ attemptId, outcome }) {
    if (!safeId(attemptId) || !['completed', 'failed'].includes(outcome))
      throw new TypeError('invalid_conversation_audit_outcome');
    const result = this.finishUpdate.run({ attemptId, outcome, now: this.clock().toISOString() });
    if (result.changes !== 1) throw new Error('conversation_audit_transition_conflict');
    return this.getOne.get(attemptId);
  }
}
