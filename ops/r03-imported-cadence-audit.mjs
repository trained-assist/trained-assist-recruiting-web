import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [releaseDirectory, stagedDbPath] = process.argv.slice(2);
const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
try {
  if (![releaseDirectory, stagedDbPath].every(absolute)) throw new Error('invalid_paths');
  const require = createRequire(join(releaseDirectory, 'package.json'));
  const Database = require('better-sqlite3');
  const { nextOccurrenceAfter, latestDueSlot } = await import(pathToFileURL(
    join(releaseDirectory, 'src/cold-search-schedules.js')).href);
  const db = new Database(stagedDbPath, { readonly: true, fileMustExist: true });
  let schedules;
  try {
    schedules = db.prepare('SELECT payload FROM cold_search_schedules').all()
      .map(row => JSON.parse(row.payload));
  } finally { db.close(); }
  if (schedules.length !== 11 || schedules.some(row => row.enabled ||
      row.timezone !== 'Europe/Moscow' || !row.blockedByUnknownOccurrenceId))
    throw new Error('schedule_stage_changed');
  const fixed = '2026-10-06T00:00:00.000Z';
  const later = '2026-10-08T01:00:00.000Z';
  const now = new Date().toISOString();
  const intervalCounts = {};
  const nextByInterval = new Map();
  for (const schedule of schedules) {
    const first = nextOccurrenceAfter(schedule.plan, fixed);
    const second = nextOccurrenceAfter(schedule.plan, first);
    const due = latestDueSlot(schedule.plan, first, later);
    if (!(first > fixed && second > first && due.scheduledAt <= later &&
        due.nextRunAt > later && due.missedCount >= 0))
      throw new Error('cadence_invariant_failed');
    const interval = String(schedule.plan.intervalHours);
    intervalCounts[interval] = (intervalCounts[interval] ?? 0) + 1;
    const next = nextOccurrenceAfter(schedule.plan, now);
    const group = nextByInterval.get(interval) ?? [];
    group.push(next);
    nextByInterval.set(interval, group);
  }
  const nextWindows = Object.fromEntries([...nextByInterval].map(([interval, slots]) =>
    [interval, { earliestUtc: slots.sort()[0], latestUtc: slots.at(-1) }]));
  process.stdout.write(JSON.stringify({ event: 'r03.imported_cadence_audit',
    status: 'passed', checked: schedules.length, fixedClockUtc: fixed,
    laterClockUtc: later, observedAtUtc: now, intervalHours: intervalCounts,
    nextNaturalWindowsUtc: nextWindows }) + '\n');
} catch {
  process.stdout.write('{"event":"r03.imported_cadence_audit","status":"failed"}\n');
  process.exitCode = 78;
}
