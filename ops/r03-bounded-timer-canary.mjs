import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Private one-shot timer entrypoint. The selection receipt contains the
// already rehearsed owned scope; no profile or vacancy ID is placed in the
// unit, process arguments, stdout or journal.
const [releaseDirectory, hostConfigFile, stageReceiptFile, secretsDirectory,
  selectionReceiptFile, outputDirectory] = process.argv.slice(2);
const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
if (![releaseDirectory, hostConfigFile, stageReceiptFile, secretsDirectory,
  selectionReceiptFile, outputDirectory].every(absolute)) {
  process.stdout.write('{"event":"r03.timer_canary","status":"invalid_arguments"}\n');
  process.exit(78);
}

try {
  const previous = JSON.parse(readFileSync(selectionReceiptFile, 'utf8'));
  if (previous?.version !== 'r03-private-scheduled-rehearsal-v1' ||
      previous.disposition !== 'partial_rehearsal' || previous.acceptedForMorning !== false ||
      previous.limits?.queries !== 1 || previous.limits?.pages !== 1 ||
      previous.limits?.perPage !== 1 || previous.limits?.hhAttempts !== 1 ||
      previous.limits?.assessments !== 1) throw new Error('invalid_selection_receipt');
  const moduleUrl = pathToFileURL(join(releaseDirectory, 'src/r03-private-scheduled-rehearsal.js'));
  const { runPrivateScheduledRehearsal } = await import(moduleUrl.href);
  const result = await runPrivateScheduledRehearsal({ hostConfigFile, stageReceiptFile,
    secretsDirectory, outputDirectory, profileId: previous.profileId,
    vacancyId: previous.vacancyId, execute: true });
  const safe = { event: 'r03.timer_canary', status: result.status,
    providerRequests: result.providerRequests, assessmentRequests: result.assessmentRequests,
    acceptedForMorning: result.acceptedForMorning, disposableOnly: result.disposableOnly };
  process.stdout.write(JSON.stringify(safe) + '\n');
  if (!['succeeded', 'replayed'].includes(result.status)) process.exitCode = 2;
} catch {
  process.stdout.write('{"event":"r03.timer_canary","status":"failed"}\n');
  process.exitCode = 78;
}
