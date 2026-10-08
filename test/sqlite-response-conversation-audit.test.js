import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteResponseConversationAudit } from '../src/sqlite-response-conversation-audit.js';

test('private conversation audit stores lifecycle and identifiers, never message bodies or signed URLs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'response-conversation-audit-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(await realpath(directory), 'audit.sqlite');
  const audit = new SqliteResponseConversationAudit({ filename,
    clock: () => new Date('2026-10-06T08:00:00Z') });
  t.after(() => audit.close());
  await audit.start({ attemptId: 'attempt_1', profileId: 'profile_A', vacancyId: 'vacancy_A',
    negotiationId: 'negotiation_A', chatId: '123456' });
  await audit.finish({ attemptId: 'attempt_1', outcome: 'completed' });
  const bytes = await readFile(filename);
  assert.equal(bytes.includes(Buffer.from('PRIVATE_MESSAGE_BODY')), false);
  assert.equal(bytes.includes(Buffer.from('https://private.example/signed?token=secret')), false);
});
