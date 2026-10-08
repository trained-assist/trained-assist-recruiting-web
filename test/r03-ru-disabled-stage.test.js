import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unit = readFileSync(new URL('../infra/systemd/trained-recruiting-r03-stage.service', import.meta.url), 'utf8');

test('RU staging unit pins the integrated release, isolates writable state and carries all runtime credentials', () => {
  assert.match(unit, /User=trained-recruiting/);
  assert.match(unit, /Group=trained-recruiting/);
  assert.match(unit, /WorkingDirectory=\/opt\/trained-assist-recruiting-web\/releases\/@RELEASE_SHA@/);
  assert.equal(unit.match(/@RELEASE_SHA@/g)?.length, 2);
  assert.match(unit, /--config \/var\/lib\/trained-recruiting-r03-stage\/config\.json/);
  assert.match(unit, /--secrets \$\{CREDENTIALS_DIRECTORY\} --port 18083 --live-execution/);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/trained-recruiting-r03-stage/);
  for (const name of ['legacy_page_secret', 'hh_encryption_key', 'hh_client_id',
    'hh_client_secret', 'hh_user_agent', 'ladder_token'])
    assert.match(unit, new RegExp(`^LoadCredential=${name}:`, 'm'));
  assert.doesNotMatch(unit, /(?:ExecStart.*timer|WantedBy=timers\.target|nginx|AGENT_SECRET)/);
});
