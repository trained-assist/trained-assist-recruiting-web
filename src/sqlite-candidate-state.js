import { chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { CANDIDATE_STATE_VERSION } from './candidate-state.js';

const safeProfileId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const emptyState = profileId => ({ stateVersion: CANDIDATE_STATE_VERSION, profileId,
  candidates: {}, seenByVacancy: {}, snapshotsByVacancy: {}, commentsByVacancy: {}, queriesByVacancy: {} });

// Opt-in single-host adapter for the createCandidateState store port. One
// profile row is replaced under BEGIN IMMEDIATE, so pool, seen and snapshot
// are committed together even when web and worker use separate processes.
export class SqliteCandidateStateStore {
  constructor({ filename, onStep = () => {} }) {
    if (typeof filename !== 'string' || !filename || filename === ':memory:') throw new TypeError('a durable SQLite filename is required');
    if (statSync(dirname(filename)).mode & 0o077) throw new Error('SQLite candidate-state directory must be owner-only (0700)');
    if (typeof onStep !== 'function') throw new TypeError('onStep must be a function');
    this.onStep = onStep;
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS candidate_profile_state (
      profile_id TEXT PRIMARY KEY,
      state_version TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      payload TEXT NOT NULL
    )`);
    this.byProfile = this.db.prepare('SELECT state_version, payload FROM candidate_profile_state WHERE profile_id = ?');
    this.upsert = this.db.prepare(`INSERT INTO candidate_profile_state (profile_id, state_version, revision, payload)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(profile_id) DO UPDATE SET state_version=excluded.state_version,
        revision=candidate_profile_state.revision + 1, payload=excluded.payload`);
  }

  close() { this.db.close(); }

  read(profileId) {
    if (!safeProfileId(profileId)) throw new TypeError('safe profileId is required');
    const row = this.byProfile.get(profileId);
    if (!row) return emptyState(profileId);
    if (row.state_version !== CANDIDATE_STATE_VERSION) throw new Error('candidate_state_version_mismatch');
    const state = JSON.parse(row.payload);
    if (state.profileId !== profileId || state.stateVersion !== CANDIDATE_STATE_VERSION) throw new Error('candidate_state_owner_or_version_mismatch');
    return state;
  }

  transact(profileId, fn) {
    if (!safeProfileId(profileId) || typeof fn !== 'function') throw new TypeError('safe profileId and transaction function are required');
    return this.db.transaction(() => {
      const next = this.read(profileId);
      const result = fn(next, step => this.onStep(step, structuredClone(next)));
      if (next.profileId !== profileId || next.stateVersion !== CANDIDATE_STATE_VERSION) throw new Error('candidate_state_owner_or_version_mismatch');
      this.upsert.run(profileId, CANDIDATE_STATE_VERSION, JSON.stringify(next));
      return result;
    }).immediate();
  }
}
