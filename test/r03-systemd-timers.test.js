import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../infra/systemd/${name}`, import.meta.url), 'utf8');

test('minute and score units load private credentials and require explicit live CLI mode', () => {
  for (const mode of ['minute', 'score']) {
    const unit = read(`trained-recruiting-hh-${mode}.service`);
    assert.match(unit, /^User=trained-recruiting$/m);
    assert.match(unit, /^StateDirectoryMode=0700$/m);
    assert.match(unit, /^UMask=0077$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.ok(unit.includes(`--mode ${mode} --config /etc/trained-assist/recruiting-web/config.json --secrets ${'${CREDENTIALS_DIRECTORY}'} --live-execution`));
    for (const name of ['hh_encryption_key', 'hh_client_id', 'hh_client_secret', 'ladder_token'])
      assert.match(unit, new RegExp(`^LoadCredential=${name}:`, 'm'));
    assert.doesNotMatch(unit, /AGENT_SECRET|\[Install\]/);
  }
});

test('timers have exact schedules and no systemd catch-up', () => {
  const minute = read('trained-recruiting-hh-minute.timer');
  const score = read('trained-recruiting-hh-score.timer');
  assert.match(minute, /^OnCalendar=\*-\*-\* \*:\*:00$/m);
  assert.match(score, /^OnCalendar=\*-\*-\* \*:0\/5:00$/m);
  for (const unit of [minute, score]) {
    assert.match(unit, /^Persistent=false$/m);
    assert.match(unit, /^AccuracySec=1s$/m);
    assert.match(unit, /^WantedBy=timers.target$/m);
  }
});
