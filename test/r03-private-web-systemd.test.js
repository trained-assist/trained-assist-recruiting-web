import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unit = readFileSync(new URL('../infra/systemd/trained-recruiting-hh-web.service', import.meta.url), 'utf8');
const bffUnit = readFileSync(new URL('../infra/systemd/trained-recruiting-hh-web-bff.service', import.meta.url), 'utf8');
const bffR04Unit = readFileSync(new URL('../infra/systemd/trained-recruiting-hh-web-bff-r04.service', import.meta.url), 'utf8');
const nginx = readFileSync(new URL('../infra/nginx/recruiting-proactive.locations.conf', import.meta.url), 'utf8');
const bffNginx = readFileSync(new URL('../infra/nginx/recruiting-connected-bff.locations.conf', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../src/r03-private-web-runtime.js', import.meta.url), 'utf8');

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

test('BFF unit uses service credentials and separate private SQLite without legacy secret', () => {
  assert.match(bffUnit, /^User=trained-recruiting$/m);
  assert.match(bffUnit, /^UMask=0077$/m);
  assert.match(bffUnit, /^LoadCredential=cp_service_key:/m);
  assert.match(bffUnit, /^LoadCredential=bff_encryption_key:/m);
  assert.match(bffUnit, /^LoadCredential=hh_user_agent:/m);
  const requiredSecrets = [...runtimeSource.matchAll(/loadPrivateHostSecret\(secretsDirectory, '([^']+)'\)/g)]
    .map(match => match[1]).filter(name => !['legacy_page_secret', 'report_drafts_encryption_key'].includes(name));
  for (const name of requiredSecrets) {
    assert.match(bffUnit, new RegExp(`^LoadCredential=${name}:`, 'm'));
  }
  assert.doesNotMatch(bffUnit, /^LoadCredential=legacy_page_secret:/m);
  assert.doesNotMatch(bffUnit, /^LoadCredential=report_drafts_encryption_key:/m,
    'report encryption key stays outside the default BFF unit until the explicit report runtime is installed');
  assert.doesNotMatch(bffUnit, /--report-drafts-db/);
  assert.match(bffUnit, /--connected-bff --cp-issuer \$\{CP_ISSUER\} --public-origin https:\/\/recruiter-assistant\.ru --bff-db \/var\/lib\/trained-assist\/recruiting-web\/bff\.sqlite/);
  assert.match(bffUnit, /^ReadWritePaths=\/var\/lib\/trained-assist\/recruiting-web$/m);
  assert.match(bffNginx, /^location \^~ \/auth\/connected\/ \{$/m);
  assert.match(bffNginx, /^\s*access_log off;$/m);
});

test('R-04 opt-in unit mounts encrypted drafts only with its dedicated credential and DB', () => {
  assert.match(bffR04Unit, /^User=trained-recruiting$/m);
  assert.match(bffR04Unit, /^UMask=0077$/m);
  assert.match(bffR04Unit, /^Conflicts=trained-recruiting-hh-web-bff\.service$/m);
  assert.match(bffR04Unit, /^LoadCredential=report_drafts_encryption_key:/m);
  assert.match(bffR04Unit, /--connected-bff .*--bff-db \/var\/lib\/trained-assist\/recruiting-web\/bff\.sqlite --report-drafts-db \/var\/lib\/trained-assist\/recruiting-web\/reports\.sqlite$/m);
  assert.match(bffR04Unit, /^ReadWritePaths=\/var\/lib\/trained-assist\/recruiting-web$/m);
  assert.doesNotMatch(bffR04Unit, /^LoadCredential=legacy_page_secret:/m);
  assert.doesNotMatch(bffUnit, /report_drafts_encryption_key|--report-drafts-db/,
    'default Connected App service must not mount R-04 drafts');
});

test('unapplied cutover snippet routes the page, history, script and all proactive API calls together', () => {
  assert.match(nginx, /^location = \/hh\/proactive \{$/m);
  assert.match(nginx, /^location = \/hh\/proactive\/app\.js \{$/m);
  assert.match(nginx, /^location = \/hh\/proactive\/history \{$/m);
  assert.match(nginx, /^location \^~ \/api\/hh\/proactive\/ \{$/m);
  assert.equal((nginx.match(/proxy_pass http:\/\/127\.0\.0\.1:18083;/g) ?? []).length, 4);
  assert.doesNotMatch(nginx, /proxy_pass https?:\/\/(?!127\.0\.0\.1:18083)/);
  assert.match(nginx, /Do not include until the cutover gate passes/);
});
