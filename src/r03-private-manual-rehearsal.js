import { createHash } from 'node:crypto';
import { lstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadPrivateHostConfig, loadPrivateHostSecret } from './r03-private-host-config.js';
import { readPrivateJson, privateDirectory } from './r03-private-legacy-archive.js';
import { createPrivateBaseSearchPlan } from './r03-private-base-plan.js';
import { createPrivateHhCredentialBroker } from './r03-private-hh-credential.js';
import { createHhResumeTransport } from './hh-resume-transport.js';
import { createOfflineHhColdSearch } from './hh-cold-search-offline.js';
import { SqliteRealHhCandidateState } from './sqlite-real-hh-candidate-state.js';
import { SqliteRealHhManualRuns } from './sqlite-real-hh-manual-runs.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('private_manual_rehearsal_unavailable'); };

// A disposable-DB manual run with a hard budget of one query, one HH request,
// one page and one resume. It creates a real manual receipt only inside that
// copy; the imported migration DB is never opened for writing.
export async function runPrivateManualRehearsal({ hostConfigFile, stageReceiptFile,
  secretsDirectory, profileId, vacancyId, execute = false,
  fetchImpl = globalThis.fetch, clock = () => new Date(), wait = ms =>
    new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!execute || !safeId(profileId) || !safeId(vacancyId) ||
      ![hostConfigFile, stageReceiptFile, secretsDirectory].every(path =>
        typeof path === 'string' && isAbsolute(path) && resolve(path) === path) ||
      typeof fetchImpl !== 'function' || typeof clock !== 'function' || typeof wait !== 'function') fail();
  const host = loadPrivateHostConfig(hostConfigFile);
  if (!host.isVacancyOwned(profileId, vacancyId)) fail();
  const stage = readPrivateJson(stageReceiptFile, 1024 * 1024);
  if (stage?.version !== 'r03-private-schedule-stage-v1' || stage.status !== 'disposable_only' ||
      stage.sourceDbPath !== host.dbPath || stage.stagedDbPath !== join(dirname(stageReceiptFile), 'candidate.sqlite') ||
      stage.stagedDbPath === host.dbPath || stage.imported !== 11 || stage.unknownQuarantined !== 8 || stage.enabled !== 0) fail();
  privateDirectory(dirname(stage.stagedDbPath));
  const dbInfo = lstatSync(stage.stagedDbPath);
  if (!dbInfo.isFile() || dbInfo.mode & 0o077 || dbInfo.uid !== process.getuid()) fail();
  const readonly = new Database(stage.stagedDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = readonly.prepare('SELECT payload,enabled,blocked_by_unknown_occurrence_id FROM cold_search_schedules').all();
    const imported = readonly.prepare('SELECT COUNT(*) AS n FROM r03_legacy_schedule_import').get().n;
    const occurrences = readonly.prepare('SELECT COUNT(*) AS n FROM cold_search_occurrences').get().n;
    if (rows.length !== 11 || imported !== 11 || occurrences !== 0 ||
        rows.some(row => row.enabled !== 0 || !row.blocked_by_unknown_occurrence_id) ||
        rows.filter(row => JSON.parse(row.payload).migrationQuarantine?.reason === 'legacy_outcome_unknown').length !== 8)
      fail();
  } finally { readonly.close(); }
  const userAgent = loadPrivateHostSecret(secretsDirectory, 'hh_user_agent');
  const encryptionKey = loadPrivateHostSecret(secretsDirectory, 'hh_encryption_key');
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) fail();
  const loadBase = createPrivateBaseSearchPlan({ resolveProfileBinding: host.resolveProfileBinding,
    isVacancyOwned: host.isVacancyOwned });
  const base = await loadBase(profileId, vacancyId, { allowGeneration: false });
  if (base.queryCache.pendingGeneration || !base.queryCache.queries.length) fail();
  const plan = { ...base, queryCache: { ...base.queryCache,
    queries: [base.queryCache.queries[0]],
    revision: `rehearsal-${hash([base.queryCache.revision, base.queryCache.queries[0]]).slice(0, 24)}` } };
  const loadSearchPlan = async (requestedProfile, requestedVacancy) => {
    const current = await loadBase(requestedProfile, requestedVacancy, { allowGeneration: false });
    if (current.profileId !== profileId || current.vacancyId !== vacancyId ||
        current.queryCache.revision !== base.queryCache.revision ||
        current.criteriaRevision !== base.criteriaRevision ||
        current.queryCache.queries[0] !== base.queryCache.queries[0]) fail();
    return plan;
  };
  const credentials = createPrivateHhCredentialBroker({ resolveProfileBinding: host.resolveProfileBinding,
    encryptionKey, fetchImpl });
  await credentials.loadCredential(profileId); // fail before a manual run row is created
  const context = { profileId, scopes: ['recruiting.candidateSearch'] };
  let providerRequests = 0;
  const boundedFetch = async (url, init) => {
    if (++providerRequests > 1 || init?.method !== 'GET' ||
        new URL(url).origin !== 'https://api.hh.ru' ||
        new URL(url).pathname !== '/resumes' ||
        new URL(url).searchParams.get('page') !== '0' ||
        new URL(url).searchParams.get('per_page') !== '1') fail();
    return fetchImpl(url, init);
  };
  const transport = createHhResumeTransport({
    loadVacancyContext: async (p, v) => ({ profileId: p, vacancyId: v, config: plan.atsConfig }),
    loadCredential: credentials.loadCredential, fetchImpl: boundedFetch, userAgent,
    pageLimit: 1, perPage: 1, maxAttempts: 1, allowPartialWindow: true });
  let providerPages = null;
  const onePage = { search: async input => {
    const result = await transport.search(input);
    providerPages = result.pages;
    return result;
  } };
  const candidates = new SqliteRealHhCandidateState({ filename: stage.stagedDbPath,
    isVacancyOwned: host.isVacancyOwned });
  let manual;
  try {
    const search = createOfflineHhColdSearch({ loadSearchPlan, transport: onePage,
      candidateState: candidates, clock });
    manual = new SqliteRealHhManualRuns({ filename: stage.stagedDbPath,
      isVacancyOwned: host.isVacancyOwned, loadSearchPlan, search, candidateState: candidates,
      clock, leaseMs: 90_000 });
    const idempotencyKey = `rehearsal_${hash([stage.migrationId, profileId, vacancyId,
      plan.criteriaRevision, plan.queryCache.revision]).slice(0, 32)}`;
    const started = await manual.start(context, idempotencyKey, { vacancyId,
      criteriaRevision: plan.criteriaRevision, queryRevision: plan.queryCache.revision });
    if (!['created', 'replay'].includes(started.kind)) fail();
    let current = started.run;
    for (let attempt = 0; attempt < 160 && current.status === 'running'; attempt++) {
      await wait(250);
      const polled = manual.get(context, current.runId);
      if (polled.kind !== 'found') fail();
      current = polled.run;
    }
    if (current.status === 'running') fail();
    const snapshot = current.status === 'completed'
      ? candidates.resultPage({ profileId, vacancyId, jobId: current.resultJobId, limit: 1 })?.snapshot : null;
    if (current.status === 'completed' && (!snapshot || snapshot.candidateCount > 1 ||
        snapshot.source !== 'manual' || snapshot.profileId !== profileId ||
        snapshot.vacancyId !== vacancyId)) fail();
    const receipt = { version: 'r03-private-manual-rehearsal-v1', status: current.status,
      migrationId: stage.migrationId, sourceArchiveSha256: stage.sourceArchiveSha256,
      cronSha256: stage.cronSha256, profileId, vacancyId, runId: current.runId,
      resultJobId: current.resultJobId, stagedDbPath: stage.stagedDbPath,
      limits: { queries: 1, pages: 1, perPage: 1, attempts: 1 },
      providerRequests, providerPages, candidateCount: snapshot?.candidateCount ?? 0,
      newCount: snapshot?.newCount ?? 0, disposition: 'disposable_only' };
    const receiptFile = join(dirname(stageReceiptFile), 'manual-rehearsal-receipt.json');
    writeFileSync(receiptFile, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: current.status, providerRequests, queryBudget: 1, pageBudget: 1,
      perPage: 1, candidateCount: receipt.candidateCount, newCount: receipt.newCount,
      disposableOnly: true };
  } finally { manual?.close(); candidates.close(); }
}

function args(argv) {
  const map = { '--host-config': 'hostConfigFile', '--stage-receipt': 'stageReceiptFile',
    '--secrets': 'secretsDirectory', '--profile': 'profileId', '--vacancy': 'vacancyId' };
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute' && out.execute === undefined) out.execute = true;
    else {
      const field = map[argv[i]];
      if (!field || out[field] !== undefined) fail();
      out[field] = argv[++i];
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runPrivateManualRehearsal(args(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ event: 'r03.private_manual_rehearsal', ...result }) + '\n');
    if (result.status !== 'completed') process.exitCode = 2;
  } catch {
    process.stdout.write(JSON.stringify({ event: 'r03.private_manual_rehearsal', status: 'failed',
      code: 'private_manual_rehearsal_unavailable' }) + '\n');
    process.exitCode = 78;
  }
}
