const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validQueries = queries => Array.isArray(queries) && queries.length >= 1 && queries.length <= 15 &&
  queries.every(query => typeof query === 'string' && query.trim() === query && query.length > 0 && query.length <= 500) &&
  new Set(queries).size === queries.length;

// Target-side cache. A frozen legacy backup is never rewritten just to refresh
// search queries. The first validated concurrent writer wins for one source hash.
export class SqlitePrivateBaseQueryCache {
  constructor({ db } = {}) {
    if (typeof db?.prepare !== 'function' || typeof db?.exec !== 'function')
      throw new TypeError('private SQLite database required');
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS r03_private_base_query_cache (
      profile_id TEXT NOT NULL, vacancy_id TEXT NOT NULL, config_hash TEXT NOT NULL,
      queries TEXT NOT NULL, PRIMARY KEY(profile_id, vacancy_id, config_hash)
    )`);
    this.read = db.prepare(`SELECT queries FROM r03_private_base_query_cache
      WHERE profile_id=? AND vacancy_id=? AND config_hash=?`);
    this.write = db.prepare(`INSERT OR IGNORE INTO r03_private_base_query_cache
      (profile_id, vacancy_id, config_hash, queries) VALUES(?,?,?,?)`);
  }

  checkKey(profileId, vacancyId, configHash) {
    if (!safeId(profileId) || !safeId(vacancyId) ||
        typeof configHash !== 'string' || !/^[a-f0-9]{12}$/.test(configHash))
      throw new TypeError('invalid_private_query_cache_key');
  }

  get(profileId, vacancyId, configHash) {
    this.checkKey(profileId, vacancyId, configHash);
    const row = this.read.get(profileId, vacancyId, configHash);
    if (!row) return null;
    let queries;
    try { queries = JSON.parse(row.queries); } catch { throw new Error('private_query_cache_invalid'); }
    if (!validQueries(queries)) throw new Error('private_query_cache_invalid');
    return queries;
  }

  store(profileId, vacancyId, configHash, queries) {
    this.checkKey(profileId, vacancyId, configHash);
    if (!validQueries(queries)) throw new TypeError('invalid_private_query_set');
    this.write.run(profileId, vacancyId, configHash, JSON.stringify(queries));
    return this.get(profileId, vacancyId, configHash);
  }
}
