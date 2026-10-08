import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Two explicit operator phases. Preflight makes page-zero HH GETs and writes
// its own private receipt. Only a fresh ready seven-query receipt may reach
// the one-shot timer phase. The implementation makes no ATS or LLM call.
const [mode, releaseDirectory, hostConfigFile, stageReceiptFile, secretsDirectory,
  selectionReceiptFile, preflightReceiptFile, outputDirectory] = process.argv.slice(2);
const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const fail = () => { throw new Error('full_timer_canary_unavailable'); };
try {
  if (!['preflight', 'run'].includes(mode) ||
      ![releaseDirectory, hostConfigFile, stageReceiptFile, secretsDirectory,
        selectionReceiptFile, preflightReceiptFile, outputDirectory].every(absolute)) fail();
  const selected = JSON.parse(readFileSync(selectionReceiptFile, 'utf8'));
  if (selected?.version !== 'r03-private-full-discovery-rehearsal-v1' ||
      selected.disposition !== 'disposable_full' ||
      selected.disposableDiscoveryComplete !== true ||
      selected.queryCount !== 7 || selected.published !== false) fail();
  const moduleName = mode === 'preflight' ? 'r03-private-full-cost-preflight.js' :
    'r03-private-full-discovery-rehearsal.js';
  const moduleUrl = pathToFileURL(join(releaseDirectory, 'src', moduleName));
  if (mode === 'preflight') {
    const { runPrivateFullCostPreflight } = await import(moduleUrl.href);
    const result = await runPrivateFullCostPreflight({ hostConfigFile, stageReceiptFile,
      secretsDirectory, outputFile: preflightReceiptFile, profileId: selected.profileId,
      vacancyId: selected.vacancyId, execute: true });
    const ready = result.status === 'ready' && result.queryCount === 7 &&
      result.estimatedRequests <= 80 && result.rawItemUpperBound <= 3000;
    process.stdout.write(JSON.stringify({ event: 'r03.full_timer_preflight',
      status: ready ? 'ready' : 'blocked', queryCount: result.queryCount,
      requests: result.requests, estimatedRequests: result.estimatedRequests,
      rawItemUpperBound: result.rawItemUpperBound }) + '\n');
    if (!ready) process.exitCode = 2;
  } else {
    const preflight = JSON.parse(readFileSync(preflightReceiptFile, 'utf8'));
    if (preflight?.version !== 'r03-full-discovery-cost-preflight-v1' ||
        preflight.status !== 'ready' || preflight.queryCount !== 7 ||
        preflight.estimatedRequests > 80 || preflight.rawItemUpperBound > 3000 ||
        preflight.profileId !== selected.profileId ||
        preflight.vacancyId !== selected.vacancyId) fail();
    const { runPrivateFullDiscoveryRehearsal } = await import(moduleUrl.href);
    const result = await runPrivateFullDiscoveryRehearsal({ hostConfigFile,
      stageReceiptFile, preflightReceiptFile, secretsDirectory,
      outputDirectory, profileId: selected.profileId, vacancyId: selected.vacancyId,
      execute: true });
    process.stdout.write(JSON.stringify({ event: 'r03.full_timer_canary',
      status: result.status, originalStatus: result.originalStatus,
      providerRequests: result.providerRequests,
      assessmentRequests: result.assessmentRequests,
      queryCount: result.queryCount, candidateCount: result.candidateCount,
      newCount: result.newCount,
      disposableDiscoveryComplete: result.disposableDiscoveryComplete,
      published: result.published }) + '\n');
    if (result.status !== 'succeeded' &&
        !(result.status === 'replayed' && result.originalStatus === 'succeeded'))
      process.exitCode = 2;
  }
} catch {
  process.stdout.write(JSON.stringify({ event: mode === 'preflight' ?
    'r03.full_timer_preflight' : 'r03.full_timer_canary', status: 'failed' }) + '\n');
  process.exitCode = 78;
}
