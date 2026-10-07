export class SqliteMinuteWorkerLease {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS r03_minute_worker_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner TEXT NOT NULL, expires_at TEXT NOT NULL
    )`);
  }

  acquire({ owner, now, expiresAt }) {
    if (!owner || expiresAt <= now) throw new TypeError('valid worker lease is required');
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT owner, expires_at FROM r03_minute_worker_lease WHERE singleton = 1').get();
      if (current && current.expires_at > now) return false;
      this.db.prepare(`INSERT INTO r03_minute_worker_lease(singleton, owner, expires_at)
        VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at`).run(owner, expiresAt);
      return true;
    }).immediate();
  }

  release(owner) {
    return this.db.prepare('DELETE FROM r03_minute_worker_lease WHERE singleton = 1 AND owner = ?').run(owner).changes === 1;
  }
}
