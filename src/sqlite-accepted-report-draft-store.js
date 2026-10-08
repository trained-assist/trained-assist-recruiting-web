import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';

const hmac = (key, purpose, value) => createHmac('sha256', key).update(`${purpose}:${value}`).digest('hex');

// Candidate report contents are personal data. Encrypt every record, keep the
// key outside the repository, and require a private host directory and file.
export class SqliteAcceptedReportDraftStore {
  constructor({ filename, encryptionKey } = {}) {
    if (typeof filename !== 'string' || !isAbsolute(filename) || resolve(filename) !== filename ||
        filename === ':memory:' || realpathSync(dirname(filename)) !== dirname(filename) ||
        (statSync(dirname(filename)).mode & 0o077) !== 0 ||
        typeof encryptionKey !== 'string' || !/^[a-f0-9]{64}$/i.test(encryptionKey))
      throw new TypeError('private_report_store_configuration_required');
    try {
      const info = lstatSync(filename);
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new TypeError('private_report_store_configuration_required');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.key = Buffer.from(encryptionKey, 'hex');
    this.db = new Database(filename, { timeout: 5000 });
    chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS accepted_report_draft (
      report_ref TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      idempotency_hash TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      sealed_record TEXT NOT NULL,
      UNIQUE(owner_hash, idempotency_hash)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS accepted_report_policy (
      policy_key TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      sealed_record TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS accepted_report_instruction (
      instruction_key TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      sealed_record TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS accepted_report_approved_version (
      version_key TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      report_ref TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      approved_at TEXT NOT NULL,
      sealed_record TEXT NOT NULL,
      UNIQUE(owner_hash, report_ref, revision)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS accepted_report_export_audit (
      event_id TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      report_ref TEXT NOT NULL,
      report_revision INTEGER NOT NULL CHECK(report_revision > 0),
      source_revision TEXT NOT NULL,
      policy_revision INTEGER NOT NULL CHECK(policy_revision >= 0),
      outcome TEXT NOT NULL CHECK(outcome = 'served'),
      occurred_at TEXT NOT NULL
    )`);
    this.listApproved = this.db.prepare(`SELECT * FROM accepted_report_approved_version
      WHERE owner_hash=? AND scope_hash=? ORDER BY approved_at DESC, revision DESC LIMIT ?`);
    this.findApprovedVersion = this.db.prepare(`SELECT * FROM accepted_report_approved_version
      WHERE version_key=? AND owner_hash=?`);
    this.insertExportAudit = this.db.prepare(`INSERT INTO accepted_report_export_audit
      (event_id,owner_hash,report_ref,report_revision,source_revision,policy_revision,outcome,occurred_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    this.listExportAuditRows = this.db.prepare(`SELECT report_ref,report_revision,source_revision,
      policy_revision,outcome,occurred_at FROM accepted_report_export_audit
      WHERE owner_hash=? AND report_ref=? ORDER BY occurred_at,event_id`);
    this.findByKey = this.db.prepare('SELECT * FROM accepted_report_draft WHERE owner_hash=? AND idempotency_hash=?');
    this.findByRef = this.db.prepare('SELECT * FROM accepted_report_draft WHERE report_ref=? AND owner_hash=?');
    this.insert = this.db.prepare(`INSERT INTO accepted_report_draft
      (report_ref,owner_hash,idempotency_hash,fingerprint_hash,revision,sealed_record) VALUES (?,?,?,?,?,?)`);
    this.replace = this.db.prepare(`UPDATE accepted_report_draft SET revision=?,sealed_record=?
      WHERE report_ref=? AND owner_hash=? AND revision=?`);
    this.findPolicy = this.db.prepare('SELECT * FROM accepted_report_policy WHERE policy_key=? AND owner_hash=?');
    this.insertPolicy = this.db.prepare(`INSERT INTO accepted_report_policy
      (policy_key,owner_hash,revision,sealed_record) VALUES (?,?,?,?)`);
    this.replacePolicyRow = this.db.prepare(`UPDATE accepted_report_policy SET revision=?,sealed_record=?
      WHERE policy_key=? AND owner_hash=? AND revision=?`);
    this.findInstruction = this.db.prepare('SELECT * FROM accepted_report_instruction WHERE instruction_key=? AND owner_hash=?');
    this.insertInstruction = this.db.prepare(`INSERT INTO accepted_report_instruction
      (instruction_key,owner_hash,revision,sealed_record) VALUES (?,?,?,?)`);
    this.replaceInstructionRow = this.db.prepare(`UPDATE accepted_report_instruction SET revision=?,sealed_record=?
      WHERE instruction_key=? AND owner_hash=? AND revision=?`);
  }

  close() { this.db.close(); this.key.fill(0); }

  ownerHash(profileId) { return hmac(this.key, 'owner', profileId); }
  idempotencyHash(key) { return hmac(this.key, 'idempotency', key); }
  fingerprintHash(fingerprint) { return hmac(this.key, 'fingerprint', fingerprint); }
  policyKey(profileId, candidateId, vacancyId) {
    return hmac(this.key, 'policy', `${profileId}\0${candidateId}\0${vacancyId}`);
  }

  instructionKey(profileId, scopeType, scopeId) {
    return hmac(this.key, 'report-instructions', `${profileId}\0${scopeType}\0${scopeId}`);
  }

  reportScopeHash(profileId, candidateId, vacancyId) {
    return hmac(this.key, 'approved-report-scope', `${profileId}\0${candidateId}\0${vacancyId}`);
  }

  listApprovedVersions(profileId, candidateId, vacancyId, limit = 20) {
    const ownerHash = this.ownerHash(profileId);
    const rows = this.listApproved.all(ownerHash, this.reportScopeHash(profileId, candidateId, vacancyId), limit);
    return rows.map(row => this.open(row));
  }

  listExportAudit(profileId, reportRef) {
    return this.listExportAuditRows.all(this.ownerHash(profileId), reportRef).map(row => ({
      reportRef: row.report_ref, reportRevision: row.report_revision,
      sourceRevision: row.source_revision, policyRevision: row.policy_revision,
      outcome: row.outcome, occurredAt: row.occurred_at,
    }));
  }

  getReportInstructions(profileId, scopeType, scopeId) {
    const ownerHash = this.ownerHash(profileId);
    const instructionKey = this.instructionKey(profileId, scopeType, scopeId);
    const row = this.findInstruction.get(instructionKey, ownerHash);
    if (!row) return null;
    const record = this.open({ ...row, report_ref: row.instruction_key });
    if (record.profileId !== profileId || record.scopeType !== scopeType || record.scopeId !== scopeId)
      throw new Error('report_instructions_invalid');
    return record;
  }

  replaceReportInstructions({ profileId, scopeType, scopeId, expectedRevision, record }) {
    const ownerHash = this.ownerHash(profileId);
    const instructionKey = this.instructionKey(profileId, scopeType, scopeId);
    return this.db.transaction(() => {
      const row = this.findInstruction.get(instructionKey, ownerHash);
      const current = row ? this.open({ ...row, report_ref: row.instruction_key }) : null;
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) return { kind: 'stale_instructions', record: current };
      if (current && JSON.stringify(current.instructions) === JSON.stringify(record.instructions))
        return { kind: 'existing', record: current };
      const historyEntry = { revision: revision + 1, updatedAt: record.updatedAt,
        instructions: structuredClone(record.instructions) };
      const next = { ...record, reportRef: instructionKey, revision: revision + 1,
        history: [...(current?.history ?? []), historyEntry].slice(-100),
        audit: [...(current?.audit ?? []), { action: 'instructions_updated', revision: revision + 1,
          actorProfileId: record.actorProfileId, at: record.updatedAt, counts: Object.fromEntries(
            Object.entries(record.instructions).map(([field, items]) => [field, items.length])) }].slice(-100) };
      const sealed = this.seal(instructionKey, ownerHash, next);
      if (!row) this.insertInstruction.run(instructionKey, ownerHash, next.revision, sealed);
      else {
        const result = this.replaceInstructionRow.run(next.revision, sealed, instructionKey, ownerHash, revision);
        if (result.changes !== 1) return { kind: 'stale_instructions', record: this.getReportInstructions(profileId, scopeType, scopeId) };
      }
      return { kind: 'updated', record: structuredClone(next) };
    }).immediate();
  }

  seal(reportRef, ownerHash, record) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${reportRef}:${ownerHash}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  open(row) {
    const bytes = Buffer.from(row.sealed_record, 'base64');
    if (bytes.length < 29) throw new Error('report_record_invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${row.report_ref}:${row.owner_hash}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const record = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (record.reportRef !== row.report_ref || record.revision !== row.revision) throw new Error('report_record_invalid');
    return record;
  }

  getPolicy(profileId, candidateId, vacancyId) {
    const ownerHash = this.ownerHash(profileId);
    const policyKey = this.policyKey(profileId, candidateId, vacancyId);
    const row = this.findPolicy.get(policyKey, ownerHash);
    if (!row) return null;
    const policy = this.open({ ...row, report_ref: row.policy_key });
    if (policy.profileId !== profileId || policy.candidateId !== candidateId || policy.vacancyId !== vacancyId)
      throw new Error('report_policy_invalid');
    return policy;
  }

  replacePolicy({ profileId, candidateId, vacancyId, expectedRevision, record }) {
    const ownerHash = this.ownerHash(profileId);
    const policyKey = this.policyKey(profileId, candidateId, vacancyId);
    return this.db.transaction(() => {
      const row = this.findPolicy.get(policyKey, ownerHash);
      const current = row ? this.open({ ...row, report_ref: row.policy_key }) : null;
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) return { kind: 'stale_policy', policy: current };
      if (current && JSON.stringify(current.forbiddenPhrases) === JSON.stringify(record.forbiddenPhrases))
        return { kind: 'existing', policy: current };
      const next = { ...record, reportRef: policyKey, revision: revision + 1,
        audit: [...(current?.audit ?? []), { action: 'policy_updated', revision: revision + 1,
          actorProfileId: record.actorProfileId, at: record.updatedAt,
          forbiddenCount: record.forbiddenPhrases.length }] };
      const sealed = this.seal(policyKey, ownerHash, next);
      if (!row) this.insertPolicy.run(policyKey, ownerHash, next.revision, sealed);
      else {
        const result = this.replacePolicyRow.run(next.revision, sealed, policyKey, ownerHash, revision);
        if (result.changes !== 1) return { kind: 'stale_policy', policy: this.getPolicy(profileId, candidateId, vacancyId) };
      }
      return { kind: 'updated', policy: structuredClone(next) };
    }).immediate();
  }

  create({ profileId, idempotencyKey, requestFingerprint, record }) {
    const ownerHash = this.ownerHash(profileId);
    const keyHash = this.idempotencyHash(idempotencyKey);
    const fingerprintHash = this.fingerprintHash(requestFingerprint);
    return this.db.transaction(() => {
      const policyRow = this.findPolicy.get(this.policyKey(profileId, record.candidateId, record.vacancyId), ownerHash);
      if ((policyRow?.revision ?? 0) !== (record.policyRevision ?? 0)) return { kind: 'stale_policy' };
      const existing = this.findByKey.get(ownerHash, keyHash);
      if (existing) return existing.fingerprint_hash === fingerprintHash
        ? { kind: 'existing', record: this.open(existing) } : { kind: 'idempotency_conflict' };
      this.insert.run(record.reportRef, ownerHash, keyHash, fingerprintHash, record.revision,
        this.seal(record.reportRef, ownerHash, record));
      return { kind: 'created', record: structuredClone(record) };
    }).immediate();
  }

  get(profileId, reportRef) {
    const row = this.findByRef.get(reportRef, this.ownerHash(profileId));
    return row ? this.open(row) : null;
  }

  update(profileId, reportRef, expectedRevision, next) {
    const ownerHash = this.ownerHash(profileId);
    return this.db.transaction(() => {
      const row = this.findByRef.get(reportRef, ownerHash);
      if (!row) return { kind: 'not_found' };
      const current = this.open(row);
      if (current.revision !== expectedRevision) return { kind: 'stale_report', record: current };
      const policyRow = this.findPolicy.get(this.policyKey(profileId, next.candidateId, next.vacancyId), ownerHash);
      if ((policyRow?.revision ?? 0) !== (next.policyRevision ?? 0)) return { kind: 'stale_policy' };
      const result = this.replace.run(next.revision, this.seal(reportRef, ownerHash, next),
        reportRef, ownerHash, expectedRevision);
      if (result.changes !== 1) return { kind: 'stale_report', record: this.get(profileId, reportRef) };
      if (next.reviewState === 'approved' && current.reviewState !== 'approved') {
        const versionKey = `${reportRef}:r${next.revision}`;
        this.db.prepare(`INSERT INTO accepted_report_approved_version
          (version_key,owner_hash,scope_hash,report_ref,revision,approved_at,sealed_record) VALUES (?,?,?,?,?,?,?)`)
          .run(versionKey, ownerHash, this.reportScopeHash(profileId, next.candidateId, next.vacancyId),
            reportRef, next.revision, next.updatedAt, this.seal(reportRef, ownerHash, next));
      }
      return { kind: 'updated', record: structuredClone(next) };
    }).immediate();
  }

  finalizeApprovedExport({ profileId, reportRef, expectedRevision, occurredAt }) {
    const ownerHash = this.ownerHash(profileId);
    return this.db.transaction(() => {
      const row = this.findByRef.get(reportRef, ownerHash);
      if (!row) return { kind: 'not_found' };
      const current = this.open(row);
      if (current.revision !== expectedRevision)
        return { kind: 'stale_report', record: current };
      if (current.status !== 'draft' || current.reviewState !== 'approved')
        return { kind: 'not_approved', record: current };
      const policyRow = this.findPolicy.get(this.policyKey(profileId, current.candidateId,
        current.vacancyId), ownerHash);
      if ((policyRow?.revision ?? 0) !== current.policyRevision)
        return { kind: 'stale_policy', policyRevision: policyRow?.revision ?? 0 };
      const approvedRow = this.findApprovedVersion.get(`${reportRef}:r${expectedRevision}`, ownerHash);
      if (!approvedRow) return { kind: 'not_approved', record: current };
      const approved = this.open(approvedRow);
      if (approved.profileId !== profileId || approved.reportRef !== reportRef ||
          approved.revision !== expectedRevision || approved.reviewState !== 'approved' ||
          approved.sourceRevision !== current.sourceRevision || approved.policyRevision !== current.policyRevision ||
          approved.candidateId !== current.candidateId || approved.vacancyId !== current.vacancyId)
        return { kind: 'not_approved', record: current };
      this.insertExportAudit.run(randomUUID(), ownerHash, reportRef, expectedRevision,
        current.sourceRevision, current.policyRevision, 'served', occurredAt);
      return { kind: 'exported', record: approved };
    }).immediate();
  }
}
