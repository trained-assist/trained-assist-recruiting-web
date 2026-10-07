const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validQueries = queries => Array.isArray(queries) && queries.length >= 1 && queries.length <= 15 &&
  queries.every(query => typeof query === 'string' && query.trim() === query && query.length > 0 && query.length <= 500) &&
  new Set(queries).size === queries.length;

// Recruiter intent lives in target SQLite. A reset is an explicit tombstone so
// a frozen manually pinned source file cannot silently reassert itself.
export class SqlitePrivateQueryOverrides {
  constructor({ db } = {}) {
    if (typeof db?.prepare !== 'function' || typeof db?.exec !== 'function' || typeof db?.transaction !== 'function')
      throw new TypeError('private SQLite database required');
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS r03_private_query_override (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, revision INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('manual','reset')), queries TEXT,
      updated_at TEXT NOT NULL, PRIMARY KEY(profile_id,vacancy_id)
    )`);
    this.read = db.prepare('SELECT revision, mode, queries, updated_at FROM r03_private_query_override WHERE profile_id=? AND vacancy_id=?');
    this.insert = db.prepare(`INSERT INTO r03_private_query_override(profile_id,vacancy_id,revision,mode,queries,updated_at)
      VALUES(?,?,?,?,?,?)`);
    this.update = db.prepare(`UPDATE r03_private_query_override SET revision=?,mode=?,queries=?,updated_at=?
      WHERE profile_id=? AND vacancy_id=? AND revision=?`);
  }

  checkKey(profileId, vacancyId) {
    if (!safeId(profileId) || !safeId(vacancyId)) throw new TypeError('invalid_query_override_scope');
  }

  get(profileId, vacancyId) {
    this.checkKey(profileId, vacancyId);
    const row = this.read.get(profileId, vacancyId);
    if (!row) return { revision: 0, mode: 'source', queries: null, updatedAt: null };
    let queries;
    try { queries = row.queries === null ? null : JSON.parse(row.queries); }
    catch { throw new Error('private_query_override_invalid'); }
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 ||
        row.mode === 'manual' && !validQueries(queries) ||
        row.mode === 'reset' && queries !== null ||
        !['manual', 'reset'].includes(row.mode)) throw new Error('private_query_override_invalid');
    return { revision: row.revision, mode: row.mode, queries, updatedAt: row.updated_at };
  }

  save(profileId, vacancyId, expectedRevision, queries, updatedAt) {
    this.checkKey(profileId, vacancyId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        queries !== null && !validQueries(queries) ||
        typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)))
      throw new TypeError('invalid_query_override_command');
    return this.db.transaction(() => {
      const current = this.get(profileId, vacancyId);
      if (current.revision !== expectedRevision) return { kind: 'conflict', currentRevision: current.revision };
      const mode = queries === null ? 'reset' : 'manual';
      if (current.mode === mode && JSON.stringify(current.queries) === JSON.stringify(queries))
        return { kind: 'unchanged', state: current };
      const next = current.revision + 1;
      if (current.revision === 0) this.insert.run(profileId, vacancyId, next, mode,
        queries === null ? null : JSON.stringify(queries), updatedAt);
      else this.update.run(next, mode, queries === null ? null : JSON.stringify(queries),
        updatedAt, profileId, vacancyId, current.revision);
      return { kind: 'updated', state: this.get(profileId, vacancyId) };
    }).immediate();
  }
}
