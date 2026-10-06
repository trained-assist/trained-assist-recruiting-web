import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unit = readFileSync(new URL('../infra/systemd/trained-recruiting-hh-web.service', import.meta.url), 'utf8');

test('private web service stays opt-in, loopback-only and credential-scoped', () => {
  assert.match(unit, /^User=trained-recruiting$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ProtectHome=yes$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/trained-assist\/recruiting-web$/m);
  assert.match(unit, /^LoadCredential=legacy_page_secret:/m);
  assert.match(unit, /^ExecStart=.*r03-private-web-runtime\.js .*--port 18083 --live-execution$/m);
  assert.match(unit, /--secrets \$\{CREDENTIALS_DIRECTORY\}/);
  assert.doesNotMatch(unit, /(?:AGENT_SECRET|Bearer |[A-Fa-f0-9]{64})/);
  assert.doesNotMatch(unit, /^ExecStart=.*(?:0\.0\.0\.0|--host)/m);
});
