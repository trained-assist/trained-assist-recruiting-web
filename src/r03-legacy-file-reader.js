import { createHmac } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectLegacyR03Sources } from './r03-legacy-source-projection.js';

const fail = code => { throw new Error(code); };
const maxFileBytes = 64 * 1024 * 1024;

function readJson(directory, name, kind, hmacKey, receipts) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]+\.json$/.test(name)) fail('invalid_legacy_source_filename');
  const filename = join(directory, name);
  let bytes;
  let descriptor;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > maxFileBytes) fail('invalid_legacy_source_file');
    bytes = readFileSync(descriptor);
    if (bytes.length > maxFileBytes || bytes.length !== info.size) fail('legacy_source_file_changed');
  } catch (error) {
    if (['invalid_legacy_source_file', 'legacy_source_file_changed'].includes(error.message)) throw error;
    fail('legacy_source_file_unavailable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  receipts.push({ kind,
    filename: name, bytes: bytes.length,
    hmac: createHmac('sha256', hmacKey).update(bytes).digest('hex') });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('invalid_legacy_source_json'); }
}

function namesIn(directory) {
  try {
    if (!lstatSync(directory).isDirectory()) fail('invalid_legacy_source_directory');
    return readdirSync(directory).sort();
  } catch (error) {
    if (error.message === 'invalid_legacy_source_directory') throw error;
    fail('legacy_source_directory_unavailable');
  }
}

// Read-only, explicit local-source adapter. The caller must provide a frozen
// backup, not a changing live profile directory. Receipts contain keyed hashes
// of source bytes; they do not contain raw candidate or ATS content.
export function readLegacyR03ProfileFiles({ sourceProfileRef, proactiveDirectory,
  contextDirectory, schedules = [], hmacKey }) {
  if (typeof proactiveDirectory !== 'string' || !proactiveDirectory ||
      typeof contextDirectory !== 'string' || !contextDirectory ||
      !Buffer.isBuffer(hmacKey) || hmacKey.length < 32) fail('invalid_legacy_source_reader');
  const proactiveNames = namesIn(proactiveDirectory);
  const contextNames = namesIn(contextDirectory);
  if (!proactiveNames.includes('all-candidates.json') || !proactiveNames.includes('seen-ids.json'))
    fail('missing_legacy_source_core_file');
  // These singleton files cannot be scoped safely to a vacancy. An operator
  // must resolve them explicitly before import rather than silently dropping.
  if (proactiveNames.includes('candidate-comments.json') || contextNames.includes('ats_config.json'))
    fail('unscoped_legacy_source_requires_mapping');
  const families = [
    ['search-results-', /^search-results-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+\.json$/],
    ['queries-', /^queries-[A-Za-z0-9_-]+\.json$/],
    ['candidate-comments-', /^candidate-comments-[A-Za-z0-9_-]+\.json$/],
  ];
  if (proactiveNames.some(name => families.some(([prefix, pattern]) => name.startsWith(prefix) && !pattern.test(name))) ||
      contextNames.some(name => name.startsWith('ats_config:') && !/^ats_config:[A-Za-z0-9_-]+\.json$/.test(name)))
    fail('unmapped_legacy_source_filename');
  const receipts = [];
  const proactive = name => readJson(proactiveDirectory, name, 'proactive', hmacKey, receipts);
  const context = name => readJson(contextDirectory, name, 'context', hmacKey, receipts);
  const allCandidates = proactive('all-candidates.json');
  const seenIds = proactive('seen-ids.json');
  const snapshots = proactiveNames.filter(name => /^search-results-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+\.json$/.test(name))
    .map(filename => ({ filename, value: proactive(filename) }));
  const queryCaches = proactiveNames.filter(name => /^queries-[A-Za-z0-9_-]+\.json$/.test(name))
    .map(filename => ({ vacancyId: filename.slice(8, -5), value: proactive(filename) }));
  const comments = proactiveNames.filter(name => /^candidate-comments-[A-Za-z0-9_-]+\.json$/.test(name))
    .map(filename => ({ vacancyId: filename.slice(19, -5), value: proactive(filename) }));
  const atsConfigs = contextNames.filter(name => /^ats_config:[A-Za-z0-9_-]+\.json$/.test(name))
    .map(filename => ({ vacancyId: filename.slice(11, -5), value: context(filename) }));
  const profile = projectLegacyR03Sources({ sourceProfileRef, allCandidates, seenIds,
    snapshots, queryCaches, comments, atsConfigs, schedules });
  return { profile, fileReceipts: receipts };
}
